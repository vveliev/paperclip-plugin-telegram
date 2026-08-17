import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage } from "./telegram-api.js";

/**
 * Ask the user to pick from a list, in chat, and wait for the answer.
 *
 * Workflow steps run inside a single `runWorkflow` call, but a Telegram button
 * press arrives later as a separate `callback_query` update on the polling
 * loop. Bridging the two needs a pending-answer registry: the step parks a
 * promise here, the callback handler resolves it, and the step resumes.
 *
 * This registry is deliberately in-memory. A pending choice does not survive a
 * worker restart — it times out instead, which is the honest failure mode: the
 * alternative is persisting partial workflow state, and a half-resumed
 * workflow whose earlier steps already had side effects (issues created,
 * agents invoked) is worse than one that clearly gave up.
 *
 * Note `wait_approval` has the same gap and never worked: it emits
 * `cmd_approve_*` buttons that no handler consumes, so the workflow stops at
 * "awaiting_approval" forever. The same registry can fix it.
 */

type PendingChoice = {
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  chatId: string;
};

const pending = new Map<string, PendingChoice>();

/** Telegram caps callback_data at 64 bytes, so keys stay short. */
const CALLBACK_PREFIX = "wfc_";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

let counter = 0;
function nextChoiceId(): string {
  counter = (counter + 1) % 100000;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

export type ChoiceOption = { label: string; value: string };

export function normalizeOptions(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ChoiceOption[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      options.push({ label: entry, value: entry });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as { label?: unknown; value?: unknown };
      const label = typeof record.label === "string" ? record.label : undefined;
      const value = typeof record.value === "string" ? record.value : label;
      if (label && value) options.push({ label, value });
    }
  }
  return options;
}

/**
 * Send the prompt with one button per option and wait for a press.
 * Resolves to the chosen option's `value`, or null on timeout.
 */
export async function askChoice(
  ctx: PluginContext,
  token: string,
  chatId: string,
  prompt: string,
  options: ChoiceOption[],
  opts: { timeoutMs?: number; messageThreadId?: number; columns?: number } = {},
): Promise<string | null> {
  if (options.length === 0) return null;

  const choiceId = nextChoiceId();
  const columns = Math.max(1, Math.min(opts.columns ?? 1, 3));

  // Index-based callback data keeps us inside Telegram's 64-byte limit no
  // matter how long the option values are.
  const buttons = options.map((option, index) => ({
    text: option.label.slice(0, 64),
    callback_data: `${CALLBACK_PREFIX}${choiceId}_${index}`,
  }));

  const inlineKeyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += columns) {
    inlineKeyboard.push(buttons.slice(i, i + columns));
  }

  await sendMessage(ctx, token, chatId, prompt, {
    messageThreadId: opts.messageThreadId,
    inlineKeyboard,
  });

  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(choiceId);
      ctx.logger.info("Workflow choice timed out", { choiceId, chatId });
      resolve(null);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    pending.set(choiceId, {
      chatId,
      timer,
      resolve: (index) => {
        const parsed = Number(index);
        const chosen = Number.isInteger(parsed) ? options[parsed] : undefined;
        resolve(chosen ? chosen.value : null);
      },
    });
  });
}

export function isChoiceCallback(data: string): boolean {
  return data.startsWith(CALLBACK_PREFIX);
}

/**
 * Resolve a pending choice from a callback_query. Returns the chosen option's
 * label for the acknowledgement toast, or null when nothing was waiting —
 * which happens after a timeout or a worker restart.
 */
export function resolveChoiceCallback(data: string): boolean {
  if (!isChoiceCallback(data)) return false;
  const body = data.slice(CALLBACK_PREFIX.length);
  const separator = body.lastIndexOf("_");
  if (separator <= 0) return false;

  const choiceId = body.slice(0, separator);
  const index = body.slice(separator + 1);
  const entry = pending.get(choiceId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(choiceId);
  entry.resolve(index);
  return true;
}

/** Test seam: number of choices currently awaiting an answer. */
export function pendingChoiceCount(): number {
  return pending.size;
}
