import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, editMessage, answerCallbackQuery, escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";
import { METRIC_NAMES, TRUNCATE_LONG } from "./constants.js";
import { park, unpark, clear, reparkPayload, encodeCallback, decodeCallback, type ParkedFlow } from "./parked-interactions.js";

/**
 * Answer `ask_user_questions` and `request_confirmation` interactions from
 * Telegram instead of only linking to the web UI (BLA-154).
 *
 * Two constraints shape this file:
 *
 * 1. Updates are processed strictly sequentially — `for (const update of
 *    updates) { await handleUpdate(update) }` — so nothing here may await a
 *    button press. Every flow sends a message and returns; the next step runs
 *    from `resolveInteractionAnswerCallback` (button taps) or the reply-text
 *    handler in worker.ts (typed rejection reasons), both driven by a LATER
 *    update. This is the same defect that shipped and got reverted in
 *    BLA-150/BLA-153.
 * 2. Telegram caps `callback_data` at 64 bytes. A button needs to carry both
 *    an issue id and an interaction id (two UUIDs, 72+ bytes) to call the
 *    resolve endpoint, which does not fit alongside a prefix and an action.
 *    So callback_data carries a short, plugin-generated key; the key maps to
 *    the actual ids in `ctx.state`, not in the button itself.
 *
 * Scope, deliberately: only shapes that can be answered without losing
 * information. `ask_user_questions` is answerable only when every option on
 * every question is a plain pick — a question with a designer-declared
 * free-text option (`option.freeText`) still links to the web UI, because a
 * button cannot collect that text. `request_confirmation` is always
 * answerable: accepting is a button, and rejecting — with or without a
 * required reason — is "reply to this message", which the reply already
 * carries as the reason text.
 *
 * decisions.ts is the caller: the attention feed it reads (BLA-159's
 * GET /companies/:id/attention) marks `issue_thread_interaction` items
 * `inlineResolvable` and hands back a `decisionVerbs` label, but not the
 * question/option payload needed to render buttons — that still requires
 * fetching the full interaction (`fetchInteraction`, below) for the issue it
 * belongs to.
 */

const ASK_FLOW: ParkedFlow = "ask";
const CONFIRM_FLOW: ParkedFlow = "conf";

export type AskUserQuestionsOption = {
  id: string;
  label: string;
  description?: string | null;
  freeText?: boolean;
};

export type AskUserQuestionsQuestion = {
  id: string;
  prompt: string;
  helpText?: string | null;
  selectionMode: "single" | "multi";
  required?: boolean;
  options: AskUserQuestionsOption[];
};

export type AskUserQuestionsPayload = {
  version: 1;
  title?: string | null;
  questions: AskUserQuestionsQuestion[];
};

export type AskUserQuestionsAnswer = {
  questionId: string;
  optionIds: string[];
};

export type RequestConfirmationPayload = {
  version: 1;
  prompt: string;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  detailsMarkdown?: string | null;
  toolAction?: {
    risk: "write" | "destructive";
    toolDisplayName: string;
    previewMarkdown: string;
  };
};

export type AnswerableInteraction =
  | { id: string; kind: "ask_user_questions"; payload: AskUserQuestionsPayload }
  | { id: string; kind: "request_confirmation"; payload: RequestConfirmationPayload };

type ParkedAskUserQuestions = {
  kind: "ask_user_questions";
  chatId: string;
  messageThreadId?: number;
  issueId: string;
  interactionId: string;
  questions: AskUserQuestionsQuestion[];
  questionIndex: number;
  answers: AskUserQuestionsAnswer[];
  selectedOptionIds: string[];
};

type ParkedConfirmation = {
  kind: "request_confirmation";
  chatId: string;
  messageThreadId?: number;
  issueId: string;
  interactionId: string;
};

type ReplyMapping = {
  entityId: string;
  entityType: "interaction_reject_reason";
  companyId: string;
  issueId: string;
};

export function isInteractionAnswerCallback(data: string): boolean {
  const decoded = decodeCallback(data);
  return decoded?.flow === ASK_FLOW || decoded?.flow === CONFIRM_FLOW;
}

/**
 * A question is answerable via buttons only if every option on it is a plain
 * pick. A designer-declared free-text option (`option.freeText`) means the
 * question can only be answered faithfully with typed text, which buttons
 * cannot supply — so the whole interaction falls back to the web-UI link
 * rather than collecting an answer that silently drops that option.
 */
export function isAskUserQuestionsAnswerable(payload: AskUserQuestionsPayload): boolean {
  return (
    payload.questions.length > 0 &&
    payload.questions.every((q) => q.options.length > 0 && q.options.every((o) => o.freeText !== true))
  );
}

function optionLabel(option: AskUserQuestionsOption, selected: boolean, multi: boolean): string {
  const mark = multi ? (selected ? "☑ " : "☐ ") : "";
  return `${mark}${option.label}`.slice(0, 64);
}

function questionButtons(key: string, question: AskUserQuestionsQuestion, selectedOptionIds: string[]) {
  const multi = question.selectionMode === "multi";
  const rows = question.options.map((option, index) => [
    {
      text: optionLabel(option, selectedOptionIds.includes(option.id), multi),
      callback_data: encodeCallback(ASK_FLOW, key, `o${index}`),
    },
  ]);
  if (multi) {
    rows.push([{ text: "Continue ▶", callback_data: encodeCallback(ASK_FLOW, key, "done") }]);
  }
  if (!question.required) {
    rows.push([{ text: "Skip", callback_data: encodeCallback(ASK_FLOW, key, "skip") }]);
  }
  return rows;
}

function renderQuestionText(question: AskUserQuestionsQuestion, index: number, total: number): string {
  const lines = [
    escapeMarkdownV2(`Question ${index + 1} of ${total}`),
    `*${escapeMarkdownV2(question.prompt)}*`,
  ];
  if (question.helpText) lines.push(escapeMarkdownV2(question.helpText));
  if (question.selectionMode === "multi") {
    lines.push(escapeMarkdownV2("Pick any that apply, then Continue."));
  }
  return lines.join("\n");
}

async function sendAskUserQuestionsPrompt(
  ctx: PluginContext,
  token: string,
  chatId: string,
  opts: { issueId: string; interactionId: string; payload: AskUserQuestionsPayload; messageThreadId?: number },
): Promise<boolean> {
  if (!isAskUserQuestionsAnswerable(opts.payload)) return false;

  const key = await park<ParkedAskUserQuestions>(ctx, ASK_FLOW, {
    kind: "ask_user_questions",
    chatId,
    messageThreadId: opts.messageThreadId,
    issueId: opts.issueId,
    interactionId: opts.interactionId,
    questions: opts.payload.questions,
    questionIndex: 0,
    answers: [],
    selectedOptionIds: [],
  });

  const question = opts.payload.questions[0];
  await sendMessage(ctx, token, chatId, renderQuestionText(question, 0, opts.payload.questions.length), {
    parseMode: "MarkdownV2",
    messageThreadId: opts.messageThreadId,
    inlineKeyboard: questionButtons(key, question, []),
  });
  return true;
}

function renderConfirmationText(payload: RequestConfirmationPayload): string {
  const lines = [`*${escapeMarkdownV2("Confirmation needed")}*`, "", escapeMarkdownV2(payload.prompt)];
  if (payload.toolAction) {
    lines.push(
      "",
      escapeMarkdownV2(`⚠️ ${payload.toolAction.risk} action: ${payload.toolAction.toolDisplayName}`),
      escapeMarkdownV2(truncateAtWord(payload.toolAction.previewMarkdown, TRUNCATE_LONG)),
    );
  } else if (payload.detailsMarkdown) {
    lines.push("", escapeMarkdownV2(truncateAtWord(payload.detailsMarkdown, TRUNCATE_LONG)));
  }
  lines.push(
    "",
    escapeMarkdownV2(
      payload.rejectRequiresReason
        ? "Reply to this message with your reason to reject."
        : "Tap Reject, or reply to this message with a reason to reject with one.",
    ),
  );
  return lines.join("\n");
}

async function sendRequestConfirmationPrompt(
  ctx: PluginContext,
  token: string,
  chatId: string,
  opts: {
    companyId?: string;
    issueId: string;
    interactionId: string;
    payload: RequestConfirmationPayload;
    messageThreadId?: number;
  },
): Promise<boolean> {
  const key = await park<ParkedConfirmation>(ctx, CONFIRM_FLOW, {
    kind: "request_confirmation",
    chatId,
    messageThreadId: opts.messageThreadId,
    issueId: opts.issueId,
    interactionId: opts.interactionId,
  });

  const buttons = [[{ text: opts.payload.acceptLabel ?? "✅ Accept", callback_data: encodeCallback(CONFIRM_FLOW, key, "accept") }]];
  if (!opts.payload.rejectRequiresReason) {
    buttons[0].push({ text: opts.payload.rejectLabel ?? "❌ Reject", callback_data: encodeCallback(CONFIRM_FLOW, key, "reject") });
  }

  const messageId = await sendMessage(ctx, token, chatId, renderConfirmationText(opts.payload), {
    parseMode: "MarkdownV2",
    messageThreadId: opts.messageThreadId,
    inlineKeyboard: buttons,
  });

  // Replying to this message is always a valid way to reject with a reason,
  // required or not — register it the same way the issue/escalation reply
  // routing already does, so worker.ts's existing dispatcher picks it up.
  if (messageId && opts.companyId) {
    const mapping: ReplyMapping = {
      entityId: opts.interactionId,
      entityType: "interaction_reject_reason",
      companyId: opts.companyId,
      issueId: opts.issueId,
    };
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `msg_${chatId}_${messageId}` },
      mapping,
    );
  }

  return true;
}

/**
 * Send an interactive prompt for an interaction, if its shape supports one.
 * Returns false when the caller should fall back to the existing web-UI link
 * — the interaction is not answerable via Telegram buttons.
 */
export async function sendAnswerableInteraction(
  ctx: PluginContext,
  token: string,
  chatId: string,
  interaction: AnswerableInteraction,
  opts: { issueId: string; companyId?: string; messageThreadId?: number },
): Promise<boolean> {
  if (interaction.kind === "ask_user_questions") {
    return sendAskUserQuestionsPrompt(ctx, token, chatId, {
      issueId: opts.issueId,
      interactionId: interaction.id,
      payload: interaction.payload,
      messageThreadId: opts.messageThreadId,
    });
  }
  if (interaction.kind === "request_confirmation") {
    return sendRequestConfirmationPrompt(ctx, token, chatId, {
      companyId: opts.companyId,
      issueId: opts.issueId,
      interactionId: interaction.id,
      payload: interaction.payload,
      messageThreadId: opts.messageThreadId,
    });
  }
  return false;
}

// --- Fetching & resolving ---

export type FreshInteraction = { id: string; status: string; kind: string; payload: unknown };

/**
 * Fetch one interaction with its full payload — the attention feed's
 * `issue_thread_interaction` items carry only an excerpt, not the
 * question/option data buttons need. Also used, ignoring `payload`, as the
 * pre-resolve freshness check.
 */
export async function fetchInteraction(
  ctx: PluginContext,
  baseUrl: string,
  issueId: string,
  interactionId: string,
  boardApiToken?: string,
): Promise<FreshInteraction | null> {
  try {
    const response = await fetchPaperclipApi(ctx, `${baseUrl}/api/issues/${issueId}/interactions`, {
      method: "GET",
      headers: { ...buildPaperclipAuthHeaders(boardApiToken) },
    });
    const parsed = (await response.json()) as unknown;
    const list = Array.isArray(parsed) ? (parsed as FreshInteraction[]) : [];
    return list.find((item) => item.id === interactionId) ?? null;
  } catch {
    return null;
  }
}

async function postInteractionAction(
  ctx: PluginContext,
  baseUrl: string,
  issueId: string,
  interactionId: string,
  action: "accept" | "reject" | "respond",
  body: unknown,
  boardApiToken?: string,
): Promise<{ status: string }> {
  const response = await fetchPaperclipApi(ctx, `${baseUrl}/api/issues/${issueId}/interactions/${interactionId}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildPaperclipAuthHeaders(boardApiToken) },
    body: JSON.stringify(body),
  });
  return (await response.json()) as { status: string };
}

async function finishAskUserQuestions(
  ctx: PluginContext,
  token: string,
  baseUrl: string,
  boardApiToken: string | undefined,
  parked: ParkedAskUserQuestions,
  messageId?: number,
): Promise<void> {
  try {
    const result = await postInteractionAction(
      ctx,
      baseUrl,
      parked.issueId,
      parked.interactionId,
      "respond",
      { answers: parked.answers },
      boardApiToken,
    );
    await ctx.metrics.write(METRIC_NAMES.interactionAnswered, 1);
    // plain: interpolates the interaction's own status; not escaped for MarkdownV2
    const text = result.status === "answered"
      ? "✅ Answer recorded."
      : `Recorded, but the interaction is now "${result.status}". Check /decisions or the web UI.`;
    if (messageId) await editMessage(ctx, token, parked.chatId, messageId, text);
    else await sendMessage(ctx, token, parked.chatId, text, { parseMode: undefined, messageThreadId: parked.messageThreadId });
  } catch (err) {
    // plain: interpolates a raw upstream error message
    const text = `Could not submit your answer: ${err instanceof Error ? err.message : String(err)}`;
    if (messageId) await editMessage(ctx, token, parked.chatId, messageId, text);
    else await sendMessage(ctx, token, parked.chatId, text, { parseMode: undefined, messageThreadId: parked.messageThreadId });
  }
}

async function advanceAskUserQuestions(
  ctx: PluginContext,
  token: string,
  baseUrl: string,
  boardApiToken: string | undefined,
  key: string,
  parked: ParkedAskUserQuestions,
  answer: AskUserQuestionsAnswer,
  messageId?: number,
): Promise<void> {
  const answers = [...parked.answers, answer];
  const nextIndex = parked.questionIndex + 1;

  if (nextIndex >= parked.questions.length) {
    await clear(ctx, ASK_FLOW, key);
    await finishAskUserQuestions(ctx, token, baseUrl, boardApiToken, { ...parked, answers }, messageId);
    return;
  }

  const next: ParkedAskUserQuestions = { ...parked, answers, questionIndex: nextIndex, selectedOptionIds: [] };
  await reparkPayload(ctx, ASK_FLOW, key, next);
  const question = parked.questions[nextIndex];
  await sendMessage(ctx, token, parked.chatId, renderQuestionText(question, nextIndex, parked.questions.length), {
    parseMode: "MarkdownV2",
    messageThreadId: parked.messageThreadId,
    inlineKeyboard: questionButtons(key, question, []),
  });
}

async function handleAskUserQuestionsAction(
  ctx: PluginContext,
  token: string,
  baseUrl: string,
  boardApiToken: string | undefined,
  key: string,
  parked: ParkedAskUserQuestions,
  action: string,
  callbackQueryId: string,
  messageId?: number,
): Promise<void> {
  const question = parked.questions[parked.questionIndex];
  if (!question) {
    await clear(ctx, ASK_FLOW, key);
    await answerCallbackQuery(ctx, token, callbackQueryId, "This question flow is out of sync. Use /decisions to retry.");
    return;
  }

  if (action === "skip") {
    // The button is never offered for a required question, but the action is
    // still validated here rather than trusted from callback_data alone.
    if (question.required) {
      await answerCallbackQuery(ctx, token, callbackQueryId, "This question requires an answer.");
      return;
    }
    await answerCallbackQuery(ctx, token, callbackQueryId, "Skipped");
    await advanceAskUserQuestions(ctx, token, baseUrl, boardApiToken, key, parked, { questionId: question.id, optionIds: [] }, messageId);
    return;
  }

  if (action === "done") {
    if (question.required && parked.selectedOptionIds.length === 0) {
      await answerCallbackQuery(ctx, token, callbackQueryId, "Pick at least one option first.");
      return;
    }
    await answerCallbackQuery(ctx, token, callbackQueryId, "Recorded");
    await advanceAskUserQuestions(
      ctx, token, baseUrl, boardApiToken, key, parked,
      { questionId: question.id, optionIds: parked.selectedOptionIds }, messageId,
    );
    return;
  }

  const optionMatch = /^o(\d+)$/.exec(action);
  if (!optionMatch) {
    await answerCallbackQuery(ctx, token, callbackQueryId, "Unknown action");
    return;
  }
  const optionIndex = Number(optionMatch[1]);
  const option = question.options[optionIndex];
  if (!option) {
    await answerCallbackQuery(ctx, token, callbackQueryId, "Unknown option");
    return;
  }

  if (question.selectionMode === "single") {
    await answerCallbackQuery(ctx, token, callbackQueryId, `Picked: ${option.label}`);
    await advanceAskUserQuestions(ctx, token, baseUrl, boardApiToken, key, parked, { questionId: question.id, optionIds: [option.id] }, messageId);
    return;
  }

  // Multi-select: toggle and re-render this same question with updated marks.
  const selectedOptionIds = parked.selectedOptionIds.includes(option.id)
    ? parked.selectedOptionIds.filter((id) => id !== option.id)
    : [...parked.selectedOptionIds, option.id];
  await reparkPayload(ctx, ASK_FLOW, key, { ...parked, selectedOptionIds });
  await answerCallbackQuery(ctx, token, callbackQueryId, selectedOptionIds.includes(option.id) ? `Added: ${option.label}` : `Removed: ${option.label}`);
  if (messageId) {
    await editMessage(ctx, token, parked.chatId, messageId, renderQuestionText(question, parked.questionIndex, parked.questions.length), {
      parseMode: "MarkdownV2",
      inlineKeyboard: questionButtons(key, question, selectedOptionIds),
    });
  }
}

async function handleConfirmationAction(
  ctx: PluginContext,
  token: string,
  baseUrl: string,
  boardApiToken: string | undefined,
  key: string,
  parked: ParkedConfirmation,
  action: "accept" | "reject",
  callbackQueryId: string,
  messageId?: number,
): Promise<void> {
  await clear(ctx, CONFIRM_FLOW, key);
  try {
    const result = await postInteractionAction(ctx, baseUrl, parked.issueId, parked.interactionId, action, {}, boardApiToken);
    await ctx.metrics.write(METRIC_NAMES.interactionAnswered, 1);
    const expected = action === "accept" ? "accepted" : "rejected";
    const text = result.status === expected
      ? (action === "accept" ? "✅ Accepted." : "❌ Rejected.")
      : `Recorded, but the interaction is now "${result.status}". Check /decisions or the web UI.`;
    await answerCallbackQuery(ctx, token, callbackQueryId, text.replace(/[✅❌]\s*/u, ""));
    if (messageId) await editMessage(ctx, token, parked.chatId, messageId, text);
  } catch (err) {
    const text = `Could not ${action} this: ${err instanceof Error ? err.message : String(err)}`;
    await answerCallbackQuery(ctx, token, callbackQueryId, text);
    if (messageId) await editMessage(ctx, token, parked.chatId, messageId, text);
  }
}

/**
 * Resolve an `ask`/`conf`-flow callback_query. Everything needed to act
 * (issue id, interaction id, in-progress answers) lives in the parked state
 * under `key` — the callback only carried the key and the tapped action.
 */
export async function resolveInteractionAnswerCallback(
  ctx: PluginContext,
  token: string,
  data: string,
  callbackQueryId: string,
  baseUrl: string,
  boardApiToken: string | undefined,
  messageId?: number,
): Promise<boolean> {
  const decoded = decodeCallback(data);
  if (!decoded || (decoded.flow !== ASK_FLOW && decoded.flow !== CONFIRM_FLOW)) return false;
  const { flow, key, action } = decoded;

  const result = flow === ASK_FLOW
    ? await unpark<ParkedAskUserQuestions>(ctx, flow, key)
    : await unpark<ParkedConfirmation>(ctx, flow, key);
  if (result.status !== "live") {
    await answerCallbackQuery(ctx, token, callbackQueryId, "This has expired or was already answered. Use /decisions to check again.");
    return true;
  }
  const parked = result.payload;

  // Resolved against the interaction as it stands NOW, not as it was when the
  // message was sent — it may have been withdrawn, expired, or answered
  // elsewhere (web UI, another chat) since.
  const fresh = await fetchInteraction(ctx, baseUrl, parked.issueId, parked.interactionId, boardApiToken);
  if (!fresh || fresh.status !== "pending") {
    await clear(ctx, flow, key);
    const status = fresh?.status ?? "gone";
    await answerCallbackQuery(ctx, token, callbackQueryId, `This is no longer pending (${status}). Use /decisions to check again.`);
    if (messageId) {
      await editMessage(ctx, token, parked.chatId, messageId, `This is no longer pending (${status}).`);
    }
    return true;
  }

  if (parked.kind === "ask_user_questions") {
    await handleAskUserQuestionsAction(ctx, token, baseUrl, boardApiToken, key, parked, action, callbackQueryId, messageId);
    return true;
  }

  if (action !== "accept" && action !== "reject") {
    await answerCallbackQuery(ctx, token, callbackQueryId, "Unknown action");
    return true;
  }
  await handleConfirmationAction(ctx, token, baseUrl, boardApiToken, key, parked, action, callbackQueryId, messageId);
  return true;
}

/**
 * The typed-text half of the reply-to-reject flow: a message that replies to
 * a confirmation prompt becomes that confirmation's rejection reason. Called
 * from worker.ts's existing reply-routing dispatch, which already resolves
 * the `msg_${chatId}_${messageId}` mapping this module wrote at send time.
 */
export async function finalizeReplyRejection(
  ctx: PluginContext,
  token: string,
  baseUrl: string,
  boardApiToken: string | undefined,
  mapping: ReplyMapping,
  reasonText: string,
  chatId: string,
): Promise<void> {
  try {
    const fresh = await fetchInteraction(ctx, baseUrl, mapping.issueId, mapping.entityId, boardApiToken);
    if (!fresh || fresh.status !== "pending") {
      const status = fresh?.status ?? "gone";
      // plain: interpolates the interaction's own status
      await sendMessage(ctx, token, chatId, `This is no longer pending (${status}).`, { parseMode: undefined });
      return;
    }
    const result = await postInteractionAction(ctx, baseUrl, mapping.issueId, mapping.entityId, "reject", { reason: reasonText }, boardApiToken);
    await ctx.metrics.write(METRIC_NAMES.interactionAnswered, 1);
    // plain: interpolates the interaction's own status; not escaped for MarkdownV2
    const text = result.status === "rejected"
      ? "❌ Rejected with your reason."
      : `Recorded, but the interaction is now "${result.status}". Check /decisions or the web UI.`;
    await sendMessage(ctx, token, chatId, text, { parseMode: undefined });
  } catch (err) {
    // plain: interpolates a raw upstream error message
    await sendMessage(ctx, token, chatId, `Could not reject this: ${err instanceof Error ? err.message : String(err)}`, { parseMode: undefined });
  }
}

export function isInteractionReplyMapping(value: unknown): value is ReplyMapping {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).entityType === "interaction_reject_reason"
  );
}
