import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, answerCallbackQuery, escapeMarkdownV2 } from "./telegram-api.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";
import { TRUNCATE_MEDIUM } from "./constants.js";
import {
  fetchInteraction,
  sendAnswerableInteraction,
  isAskUserQuestionsAnswerable,
  type AnswerableInteraction,
  type AskUserQuestionsPayload,
  type RequestConfirmationPayload,
} from "./interaction-answers.js";

/**
 * What is actually waiting on a human, read from the same source the Decisions
 * page renders: GET /api/companies/:companyId/attention.
 *
 * Two earlier attempts got this wrong, in ways worth recording because both
 * returned a confident, plausible, incomplete answer rather than an error:
 *
 *   1. /companies/:id/decisions — a different, largely unused feature. Returns
 *      [] on an instance whose Decisions page is full.
 *   2. Walking recent issues for pending issue_thread_interactions. Correct as
 *      far as it went, but the page is not only interactions: it also surfaces
 *      blocker_attention, reviews, approvals, recovery actions and more. On a
 *      live instance showing six items, that approach found one — and it could
 *      not see the other four blockers at all, at any scan depth.
 *
 * The attention endpoint solves both: one request instead of one per issue, no
 * scan bound to apologise for, server-side ranking, and every source kind the
 * page knows about. It also returns `whyNow` and `decisionVerbs`, so the bot
 * can say what the decision IS rather than just that one exists.
 */

// GET /companies/:id/attention accepts a `limit` query param (max 100, per
// its OpenAPI spec) but no usable offset — it has a `cursor` param too, but
// the response shape for a continuation token is undocumented, so pagination
// here instead re-requests from the start with a wider `limit` each time and
// slices off the slice already shown. Simple and correct as long as the feed
// stays stably ranked between requests, which server-side ranking implies.
export const DEFAULT_DISPLAY_LIMIT = 5;
export const DECISIONS_PAGE_SIZE = 20;
const MAX_ATTENTION_LIMIT = 100;
const DECISIONS_MORE_PREFIX = "dec_more_";

export type AttentionItem = {
  id: string;
  sourceKind: string;
  title: string;
  issueIdentifier?: string;
  issueHref?: string;
  whyNow?: string;
  severity?: string;
  excerpt?: string;
  verbs: string[];
  inlineResolvable: boolean;
  // Only set for sourceKind === "issue_thread_interaction": the attention
  // feed's excerpt has no question/option payload, so answering inline needs
  // these to go fetch the full interaction from the issue it belongs to.
  interactionId?: string;
  issueId?: string;
  interactionKind?: string;
  // Only set for sourceKind === "approval": subject.id here is the approval
  // id itself, so unlike an interaction there is nothing further to fetch —
  // it goes straight into the same /api/approvals/:id/approve call
  // handleApprove already makes.
  approvalId?: string;
};

export type AttentionResult = {
  items: AttentionItem[];
  totalCount: number;
};

type RawAttention = {
  totalCount?: number;
  items?: Array<Record<string, unknown>>;
};

/** Human label for a source kind; unknown kinds degrade to the raw value. */
export function describeSourceKind(kind: string): string {
  const labels: Record<string, string> = {
    issue_thread_interaction: "Needs your answer",
    blocker_attention: "Blocked",
    approval: "Approval",
    review: "Review",
    recovery_action: "Recovery",
    failed_run: "Failed run",
    budget_alert: "Budget",
    agent_error_alert: "Agent error",
    join_request: "Join request",
    decision: "Decision",
    productivity_review: "Productivity review",
  };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

function severityMarker(severity?: string): string {
  if (severity === "high" || severity === "critical") return "🔴";
  if (severity === "low") return "⚪";
  return "🟡";
}

/**
 * Pull the one line of substance out of whichever detail shape this item has.
 * Each source kind carries a different field, and a missing one is normal
 * rather than an error — blockers have no prose at all.
 */
function extractExcerpt(detail: Record<string, unknown> | undefined): string | undefined {
  if (!detail) return undefined;
  const candidates = [detail.firstQuestionText, detail.promptExcerpt, detail.summary];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Exported so tests can build fixtures through the real mapper. They used to
 * keep a hand-copy of this function; it drifted into a second implementation
 * that no longer failed when this one broke.
 */
export function toAttentionItem(raw: Record<string, unknown>): AttentionItem {
  const subject = (raw.subject ?? {}) as Record<string, unknown>;
  const relatedIssue = (raw.relatedIssue ?? {}) as Record<string, unknown>;
  const detail = raw.detail as Record<string, unknown> | undefined;
  const verbs = Array.isArray(raw.decisionVerbs)
    ? (raw.decisionVerbs as Array<Record<string, unknown>>)
        .map((v) => (typeof v.label === "string" ? v.label : ""))
        .filter(Boolean)
    : [];
  const sourceKind = typeof raw.sourceKind === "string" ? raw.sourceKind : "unknown";
  const subjectMetadata = (subject.metadata ?? {}) as Record<string, unknown>;
  const isInteraction = sourceKind === "issue_thread_interaction";
  const isApproval = sourceKind === "approval";

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    sourceKind,
    title: typeof subject.title === "string" ? subject.title : "(untitled)",
    issueIdentifier:
      typeof relatedIssue.identifier === "string" ? relatedIssue.identifier : undefined,
    issueHref: typeof subject.href === "string" ? subject.href : undefined,
    whyNow: typeof raw.whyNow === "string" ? raw.whyNow : undefined,
    severity: typeof raw.severity === "string" ? raw.severity : undefined,
    excerpt: extractExcerpt(detail),
    verbs,
    inlineResolvable: raw.inlineResolvable === true,
    interactionId: isInteraction && typeof subject.id === "string" ? subject.id : undefined,
    issueId: isInteraction && typeof subjectMetadata.issueId === "string" ? subjectMetadata.issueId : undefined,
    interactionKind: isInteraction && typeof subjectMetadata.kind === "string" ? subjectMetadata.kind : undefined,
    approvalId: isApproval && typeof subject.id === "string" ? subject.id : undefined,
  };
}

/**
 * Fetch the full interaction and, if its shape is one Telegram can render as
 * buttons, narrow it into an AnswerableInteraction. Returns null for anything
 * that must fall back to the web-UI link: an unsupported kind, a fetch
 * failure, an interaction that resolved since the feed was read, or (for
 * ask_user_questions) a question with a designer-declared free-text option.
 */
async function tryBuildAnswerableInteraction(
  ctx: PluginContext,
  baseUrl: string,
  item: AttentionItem,
  boardApiToken?: string,
): Promise<AnswerableInteraction | null> {
  if (!item.issueId || !item.interactionId) return null;

  const fresh = await fetchInteraction(ctx, baseUrl, item.issueId, item.interactionId, boardApiToken);
  if (!fresh || fresh.status !== "pending") return null;

  if (fresh.kind === "ask_user_questions") {
    const payload = fresh.payload as AskUserQuestionsPayload;
    if (!isAskUserQuestionsAnswerable(payload)) return null;
    return { id: fresh.id, kind: "ask_user_questions", payload };
  }
  if (fresh.kind === "request_confirmation") {
    return { id: fresh.id, kind: "request_confirmation", payload: fresh.payload as RequestConfirmationPayload };
  }
  return null;
}

/**
 * Fetch everything waiting on a human. Throws on failure rather than returning
 * an empty list — "nothing is pending" must never be indistinguishable from
 * "we could not ask", which is the mistake that made the previous version
 * report an empty queue while four items sat on the page.
 */
export async function fetchAttention(
  ctx: PluginContext,
  baseUrl: string,
  companyId: string,
  boardApiToken?: string,
  limit?: number,
): Promise<AttentionResult> {
  // Without an explicit limit, the endpoint applies its own undocumented
  // default page size — observed live as returning only 5 items with
  // totalCount in the dozens, well before this plugin ever slices for
  // display. Callers must pass the count they actually intend to show so the
  // server request and the display cap agree (BLA-622).
  const query = limit ? `?limit=${Math.min(Math.max(1, Math.floor(limit)), MAX_ATTENTION_LIMIT)}` : "";
  const response = (await fetchPaperclipApi(
    ctx,
    `${baseUrl}/api/companies/${companyId}/attention${query}`,
    { method: "GET", headers: { ...buildPaperclipAuthHeaders(boardApiToken) } },
  ));

  const parsed = (await response.json()) as RawAttention;

  // An ABSENT items array is a malformed response; an EMPTY one is a genuinely
  // empty queue. Collapsing the two is how "Nothing is waiting on your input"
  // gets printed while thirteen items sit on the Decisions page — and, because
  // that sentence reads like an answer rather than a failure, the user acts on
  // it. A 200 we cannot read is still a read we could not make.
  if (!Array.isArray(parsed.items)) {
    throw new Error(
      `Attention response for company ${companyId} had no items array (received ${describeShape(parsed)}). ` +
        "Refusing to report an empty queue from a response that could not be read.",
    );
  }

  const items = parsed.items.map(toAttentionItem);

  return {
    items,
    totalCount: typeof parsed.totalCount === "number" ? parsed.totalCount : items.length,
  };
}

/**
 * Describe a response by its shape for an error message. Keys only, never
 * values — the body may carry issue titles or tokens, and this string is sent
 * to a Telegram chat.
 */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value);
  if (keys.length === 0) return "an empty object";
  return `an object with keys: ${keys.slice(0, 8).join(", ")}`;
}

export function renderAttentionItem(
  item: AttentionItem,
  publicUrl?: string,
  opts: { includeOpenLink?: boolean } = {},
): string {
  const heading = `${severityMarker(item.severity)} *${escapeMarkdownV2(item.title)}*`;
  const context = [describeSourceKind(item.sourceKind), item.issueIdentifier]
    .filter(Boolean)
    .join(" · ");
  const lines = [heading, escapeMarkdownV2(context)];

  // whyNow is the host's own one-line explanation of urgency. Preferring it
  // over anything invented here keeps the bot and the web UI telling the same
  // story about the same item.
  if (item.whyNow) lines.push("", escapeMarkdownV2(item.whyNow));

  if (item.excerpt) {
    const excerpt = item.excerpt.length > TRUNCATE_MEDIUM ? `${item.excerpt.slice(0, TRUNCATE_MEDIUM)}…` : item.excerpt;
    lines.push("", escapeMarkdownV2(excerpt));
  }

  if (item.verbs.length > 0) {
    lines.push("", escapeMarkdownV2(`Options: ${item.verbs.join(" / ")}`));
  }

  // Deep-link to the item itself, not to the Decisions index — href already
  // carries the interaction anchor, so this lands on the thing being decided.
  // Suppressed when an inline answer prompt follows this message (BLA-154) —
  // the link would just be a redundant way to do what the buttons already do.
  if (opts.includeOpenLink !== false && publicUrl && item.issueHref) {
    lines.push("", escapeMarkdownV2(`Open: ${publicUrl}${item.issueHref}`));
  }

  return lines.join("\n");
}

function approveButtonRow(approvalId: string) {
  return [[{ text: "✅ Approve", callback_data: `approve_${approvalId}` }]];
}

export async function sendAttentionList(
  ctx: PluginContext,
  token: string,
  chatId: string,
  found: AttentionResult,
  opts: {
    messageThreadId?: number;
    publicUrl?: string;
    limit?: number;
    // How many items a prior call already sent — set only by the "Show more"
    // callback, so that page re-renders only the items past what is already
    // on screen instead of repeating the first page (BLA-622).
    offset?: number;
    baseUrl?: string;
    companyId?: string;
    boardApiToken?: string;
  } = {},
): Promise<void> {
  const { items, totalCount } = found;

  if (items.length === 0) {
    await sendMessage(ctx, token, chatId, "Nothing is waiting on your input.", {
      messageThreadId: opts.messageThreadId,
    });
    return;
  }

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? DEFAULT_DISPLAY_LIMIT;
  for (const item of items.slice(offset, limit)) {
    // issue_thread_interaction and approval are the two kinds this plugin can
    // resolve inline — reviews, blockers etc. resolve through endpoints this
    // plugin does not call (BLA-154 scoped the former; BLA-622 added the
    // latter, reusing the exact endpoint /approve already calls).
    const answerable = item.sourceKind === "issue_thread_interaction" && item.inlineResolvable && opts.baseUrl
      ? await tryBuildAnswerableInteraction(ctx, opts.baseUrl, item, opts.boardApiToken)
      : null;
    const approvable = item.sourceKind === "approval" && item.inlineResolvable && item.approvalId
      ? item.approvalId
      : null;

    await sendMessage(ctx, token, chatId, renderAttentionItem(item, opts.publicUrl, { includeOpenLink: !answerable && !approvable }), {
      parseMode: "MarkdownV2",
      messageThreadId: opts.messageThreadId,
      inlineKeyboard: approvable ? approveButtonRow(approvable) : undefined,
    });

    if (answerable && item.issueId) {
      await sendAnswerableInteraction(ctx, token, chatId, answerable, {
        issueId: item.issueId,
        companyId: opts.companyId,
        messageThreadId: opts.messageThreadId,
      });
    }
  }

  // The count actually rendered so far — capped by what the feed returned,
  // since a widened `limit` can still exceed totalCount.
  const shownThrough = Math.min(limit, items.length);
  if (totalCount > shownThrough) {
    const remaining = totalCount - shownThrough;
    // Past MAX_ATTENTION_LIMIT the endpoint's own cap means a wider `limit`
    // can no longer pull in more items, so there is nothing "Show more" could
    // do — drop the button rather than offer a tap that changes nothing.
    const canPageFurther = shownThrough < MAX_ATTENTION_LIMIT;
    await sendMessage(ctx, token, chatId, `…and ${remaining} more waiting.`, {
      messageThreadId: opts.messageThreadId,
      inlineKeyboard: canPageFurther
        ? [[{ text: `Show more (+${Math.min(DECISIONS_PAGE_SIZE, remaining)})`, callback_data: `${DECISIONS_MORE_PREFIX}${shownThrough}` }]]
        : undefined,
    });
  }
}

export function isDecisionsMoreCallback(data: string): boolean {
  return data.startsWith(DECISIONS_MORE_PREFIX);
}

/**
 * Resolve a "Show more" tap. The callback carries only how many items are
 * already on screen (`offset`) — everything else (company, board token,
 * base URL) is re-resolved the same way the /decisions command itself
 * resolves it, same as resolveInteractionAnswerCallback does for answers.
 */
export async function resolveDecisionsMoreCallback(
  ctx: PluginContext,
  token: string,
  data: string,
  callbackQueryId: string,
  chatId: string,
  opts: {
    messageThreadId?: number;
    baseUrl: string;
    publicUrl?: string;
    companyId: string;
    boardApiToken?: string;
  },
): Promise<void> {
  const offset = Number(data.slice(DECISIONS_MORE_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) {
    await answerCallbackQuery(ctx, token, callbackQueryId, "Could not load more.");
    return;
  }

  await answerCallbackQuery(ctx, token, callbackQueryId, "Loading more…");
  const limit = Math.min(offset + DECISIONS_PAGE_SIZE, MAX_ATTENTION_LIMIT);

  try {
    const found = await fetchAttention(ctx, opts.baseUrl, opts.companyId, opts.boardApiToken, limit);
    await sendAttentionList(ctx, token, chatId, found, {
      messageThreadId: opts.messageThreadId,
      publicUrl: opts.publicUrl,
      baseUrl: opts.baseUrl,
      companyId: opts.companyId,
      boardApiToken: opts.boardApiToken,
      limit,
      offset,
    });
  } catch (err) {
    ctx.logger.error("Failed to load more decisions", { error: String(err) });
    await sendMessage(ctx, token, chatId, describeDecisionsError(err), { messageThreadId: opts.messageThreadId });
  }
}

/**
 * Turn a failure into something the reader can act on. A raw
 * `403: {"error":"Board access required"}` names the symptom and hides the
 * cause: the board token was not resolved for this update.
 */
export function describeDecisionsError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/\b(401|403)\b/.test(message) || /board access/i.test(message)) {
    return [
      "Can't read decisions — the bot has no board access right now.",
      "",
      "This is the plugin's board API token failing to resolve, not a permissions change on your account. It usually means the plugin config was loaded without a company scope, which happens on worker restart.",
    ].join("\n");
  }

  return `Could not load decisions: ${message}`;
}
