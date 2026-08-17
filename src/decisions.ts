import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2 } from "./telegram-api.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";

/**
 * The decision queue in Telegram — the things actually waiting on a human.
 *
 * Distinct from approvals: an approval is a yes/no on one request, whereas a
 * decision carries its own option set and applies effects when chosen. It is
 * what the /<company>/decisions page lists.
 *
 * Buttons here are deliberately NOT backed by the in-memory choice registry
 * used by workflow steps. A decision can sit unanswered for days and must
 * still be actionable after a plugin restart, so the callback carries
 * everything needed to act: the decision id and the option index.
 */

const CALLBACK_PREFIX = "dec_";

/** Telegram caps callback_data at 64 bytes. uuid(36) + index keeps us well under. */
const MAX_OPTIONS_AS_BUTTONS = 8;

export type DecisionOption = {
  id: string;
  label: string;
  description?: string | null;
  style?: string;
};

export type Decision = {
  id: string;
  title: string;
  body?: string | null;
  status: string;
  options?: DecisionOption[];
  inputs?: unknown[];
  originIssueId?: string | null;
  expiresAt?: string | null;
};

export function isDecisionCallback(data: string): boolean {
  return data.startsWith(CALLBACK_PREFIX);
}

export function buildDecisionCallback(decisionId: string, optionIndex: number): string {
  return `${CALLBACK_PREFIX}${decisionId}_${optionIndex}`;
}

export function parseDecisionCallback(data: string): { decisionId: string; optionIndex: number } | null {
  if (!isDecisionCallback(data)) return null;
  const body = data.slice(CALLBACK_PREFIX.length);
  const separator = body.lastIndexOf("_");
  if (separator <= 0) return null;
  const decisionId = body.slice(0, separator);
  const optionIndex = Number(body.slice(separator + 1));
  if (!decisionId || !Number.isInteger(optionIndex) || optionIndex < 0) return null;
  return { decisionId, optionIndex };
}

export async function fetchOpenDecisions(
  ctx: PluginContext,
  baseUrl: string,
  companyId: string,
  boardApiToken?: string,
): Promise<Decision[]> {
  const response = await fetchPaperclipApi(
    ctx,
    `${baseUrl}/api/companies/${companyId}/decisions?status=open`,
    { method: "GET", headers: { ...buildPaperclipAuthHeaders(boardApiToken) } },
  );
  const parsed = (await (response as Response).json()) as unknown;
  return Array.isArray(parsed) ? (parsed as Decision[]) : [];
}

async function fetchDecision(
  ctx: PluginContext,
  baseUrl: string,
  decisionId: string,
  boardApiToken?: string,
): Promise<Decision | null> {
  const response = await fetchPaperclipApi(ctx, `${baseUrl}/api/decisions/${decisionId}`, {
    method: "GET",
    headers: { ...buildPaperclipAuthHeaders(boardApiToken) },
  });
  const parsed = (await (response as Response).json()) as Decision | null;
  return parsed && typeof parsed === "object" ? parsed : null;
}

/**
 * A decision that collects free-text inputs cannot be answered with buttons
 * alone, so we say so and point at the web UI rather than silently submitting
 * an incomplete answer.
 */
function requiresTypedInput(decision: Decision): boolean {
  return Array.isArray(decision.inputs) && decision.inputs.length > 0;
}

export function renderDecision(decision: Decision, publicUrl?: string): string {
  const lines = [`${escapeMarkdownV2("🗳")} *${escapeMarkdownV2(decision.title)}*`];

  const body = (decision.body ?? "").trim();
  if (body) {
    const excerpt = body.length > 400 ? `${body.slice(0, 400)}…` : body;
    lines.push("", escapeMarkdownV2(excerpt));
  }

  if (decision.expiresAt) {
    lines.push("", escapeMarkdownV2(`Expires: ${decision.expiresAt}`));
  }

  if (requiresTypedInput(decision)) {
    const where = publicUrl ? ` ${publicUrl}` : "";
    lines.push("", escapeMarkdownV2(`This one needs typed input — decide it in the web UI:${where}`));
  }

  return lines.join("\n");
}

export function buildDecisionKeyboard(
  decision: Decision,
): Array<Array<{ text: string; callback_data: string }>> | undefined {
  if (requiresTypedInput(decision)) return undefined;
  const options = (decision.options ?? []).slice(0, MAX_OPTIONS_AS_BUTTONS);
  if (options.length === 0) return undefined;

  const styleMark: Record<string, string> = { destructive: "⚠️ ", primary: "✅ " };
  return options.map((option, index) => [
    {
      text: `${styleMark[option.style ?? ""] ?? ""}${option.label}`.slice(0, 64),
      callback_data: buildDecisionCallback(decision.id, index),
    },
  ]);
}

/**
 * Apply a decision chosen from a Telegram button.
 *
 * The option index is resolved against the decision as it is NOW, not as it
 * was when the message was sent — so a decision that was cancelled, expired,
 * or already decided in the web UI reports that instead of silently applying
 * an answer to a stale option set.
 */
export async function applyDecisionCallback(
  ctx: PluginContext,
  data: string,
  baseUrl: string,
  chatId: string,
  boardApiToken?: string,
): Promise<{ ok: boolean; message: string }> {
  const parsed = parseDecisionCallback(data);
  if (!parsed) return { ok: false, message: "Unrecognised decision button" };

  let decision: Decision | null;
  try {
    decision = await fetchDecision(ctx, baseUrl, parsed.decisionId, boardApiToken);
  } catch (err) {
    ctx.logger.warn("Could not load decision for callback", { error: String(err) });
    return { ok: false, message: "Could not load that decision" };
  }

  if (!decision) return { ok: false, message: "That decision no longer exists" };
  if (decision.status !== "open") return { ok: false, message: `Already ${decision.status}` };

  const option = (decision.options ?? [])[parsed.optionIndex];
  if (!option) return { ok: false, message: "That option is no longer available" };

  try {
    await fetchPaperclipApi(ctx, `${baseUrl}/api/decisions/${decision.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...buildPaperclipAuthHeaders(boardApiToken) },
      // idempotencyKey guards against Telegram delivering the same callback
      // twice, which would otherwise apply the option's effects twice.
      body: JSON.stringify({
        optionId: option.id,
        idempotencyKey: `telegram:${chatId}:${decision.id}:${option.id}`,
      }),
    });
  } catch (err) {
    ctx.logger.warn("Decision decide call failed", { decisionId: decision.id, error: String(err) });
    return { ok: false, message: "Could not record that decision" };
  }

  return { ok: true, message: option.label };
}

export async function sendDecisionList(
  ctx: PluginContext,
  token: string,
  chatId: string,
  decisions: Decision[],
  opts: { messageThreadId?: number; publicUrl?: string; limit?: number } = {},
): Promise<void> {
  if (decisions.length === 0) {
    await sendMessage(ctx, token, chatId, "Nothing is waiting on your input.", {
      messageThreadId: opts.messageThreadId,
    });
    return;
  }

  const limit = opts.limit ?? 5;
  for (const decision of decisions.slice(0, limit)) {
    await sendMessage(ctx, token, chatId, renderDecision(decision, opts.publicUrl), {
      parseMode: "MarkdownV2",
      messageThreadId: opts.messageThreadId,
      inlineKeyboard: buildDecisionKeyboard(decision),
    });
  }

  if (decisions.length > limit) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `…and ${decisions.length - limit} more. Showing the oldest ${limit}.`,
      { messageThreadId: opts.messageThreadId },
    );
  }
}
