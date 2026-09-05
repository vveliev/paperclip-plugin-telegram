import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";
import { TELEGRAM_MESSAGE_MAX_LENGTH } from "./constants.js";

// The module that owns "a reply that fits".
//
// Every other place in this codebase that sends a Telegram message decides
// for itself how to escape, how to fit, and what to do when the text is too
// long -- five different strategies, two different budgets, and no shared
// constant for Telegram's real 4096-char limit (see
// TELEGRAM_MESSAGE_MAX_LENGTH in constants.ts). This module is the single
// owner of that problem: callers hand it structured parts, declare an
// overflow policy, and get back a result that says whether every part of the
// reply actually reached the user.
//
// Structured content in. A caller builds a reply out of parts -- text, bold,
// code, link, list -- instead of hand-assembling a MarkdownV2 string, so
// escaping is unrepresentable at the call site: there is no string literal
// to forget to run through escapeMarkdownV2.
//
// No default overflow policy. `sendFittedReply` requires the caller to name
// one of "split" | "paginate" | "truncate" -- a default is exactly how a
// call site silently gets the wrong one (streaming ACP output must split;
// an error line should truncate).

export type MessagePart =
  | { kind: "text"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "list"; items: string[] };

export type OverflowPolicy =
  // Send every part, breaking across as many sequential messages as needed.
  // For streaming/log-like content where every byte matters and multiple
  // messages are an acceptable shape (e.g. ACP output).
  | "split"
  // Fit everything into exactly one message, discarding the tail at a word
  // boundary. For a reply that must stay a single message (an inline error
  // line, a status summary).
  | "truncate"
  // Same chunking as "split", but each page beyond the first is captioned
  // ("— Page 2 of 3 —") so a reader knows more is coming and roughly how
  // much. For content shaped like a list or report rather than a stream.
  | "paginate";

export type FittedReplyOptions = Omit<SendMessageOptions, "parseMode">;

export type FittedReplyResult =
  | { ok: true; messageIds: number[] }
  | { ok: false; sentMessageIds: number[]; failedAtPage: number };

// Reserves room for the paginate caption ("— Page 12 of 34 —") so appending
// it can never push an already-fitted page back over the limit. Generous on
// purpose: this trades a handful of characters of budget for never having to
// re-measure after the caption is appended.
const PAGE_CAPTION_RESERVE = 40;

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

function renderUnit(part: MessagePart): string {
  switch (part.kind) {
    case "text":
      return esc(part.value);
    case "bold":
      return `*${esc(part.value)}*`;
    case "code":
      return `\`${esc(part.value)}\``;
    case "link":
      return `[${esc(part.text)}](${part.url})`;
    case "list":
      return part.items.map((item) => `${esc("•")} ${esc(item)}`).join("\n");
  }
}

/**
 * Break a single rendered unit that alone exceeds maxLen into word-bounded
 * pieces, each provably <= maxLen. Falls back to a hard cut when there is no
 * usable word boundary (e.g. one long token with no spaces), the same rule
 * truncateAtWord uses.
 */
function splitLongUnit(unit: string, maxLen: number): string[] {
  const pieces: string[] = [];
  let remaining = unit;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(" ");
    const cut = lastSpace > maxLen * 0.5 ? lastSpace : maxLen;
    const piece = remaining.slice(0, cut).trimEnd();
    // A word boundary at position 0 (leading space) would produce an empty
    // piece and loop forever; fall back to the hard cut instead.
    pieces.push(piece.length > 0 ? piece : remaining.slice(0, maxLen));
    remaining = remaining.slice(piece.length > 0 ? cut : maxLen).trimStart();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

/** Group rendered units into chunks, each provably <= maxLen. */
function chunkUnits(units: string[], maxLen: number): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const unit of units) {
    if (unit.length > maxLen) {
      flush();
      chunks.push(...splitLongUnit(unit, maxLen));
      continue;
    }
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      flush();
      current = unit;
    }
  }
  flush();
  return chunks;
}

/**
 * Render parts into one or more MarkdownV2 chunks, each provably <= maxLen.
 * Exported for direct testing of the fitting logic without a network mock.
 */
export function fitParts(
  parts: MessagePart[],
  maxLen: number = TELEGRAM_MESSAGE_MAX_LENGTH,
): string[] {
  const units = parts.map(renderUnit).filter((u) => u.length > 0);
  return chunkUnits(units, maxLen);
}

/**
 * Send a reply built from structured parts, applying the caller's declared
 * overflow policy so the rendered text is provably <= Telegram's limit
 * before it ever reaches sendMessage. Stops at the first failed page rather
 * than continuing to send a reply that is already broken, and reports
 * exactly how much of the reply the user actually received instead of
 * collapsing everything into a swallowed `null`.
 */
export async function sendFittedReply(
  ctx: PluginContext,
  token: string,
  chatId: string,
  parts: MessagePart[],
  overflow: OverflowPolicy,
  options: FittedReplyOptions = {},
): Promise<FittedReplyResult> {
  const maxLen = TELEGRAM_MESSAGE_MAX_LENGTH;

  let pages: string[];
  if (overflow === "truncate") {
    const units = parts.map(renderUnit).filter((u) => u.length > 0);
    const full = units.join("\n\n");
    // truncateAtWord appends "..." after slicing to its budget, so its
    // output can run up to 3 chars past the budget passed in -- reserve
    // that here rather than let a page land at 4099/4096.
    pages = [full.length <= maxLen ? full : truncateAtWord(full, maxLen - 3)];
  } else if (overflow === "paginate") {
    const budget = maxLen - PAGE_CAPTION_RESERVE;
    const fitted = fitParts(parts, budget);
    pages = fitted.map((page, i) =>
      fitted.length > 1 ? `${page}\n\n${esc(`— Page ${i + 1} of ${fitted.length} —`)}` : page,
    );
  } else {
    pages = fitParts(parts, maxLen);
  }

  if (pages.length === 0) {
    throw new Error("sendFittedReply: parts rendered no content to send");
  }

  // Provable invariant: nothing handed to sendMessage below ever exceeds
  // Telegram's real limit, regardless of which policy built these pages.
  for (const page of pages) {
    if (page.length > maxLen) {
      throw new Error(
        `sendFittedReply: internal fitting failed to bound a page to ${String(maxLen)} chars (got ${String(page.length)})`,
      );
    }
  }

  const messageIds: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const isFirst = i === 0;
    const id = await sendMessage(ctx, token, chatId, pages[i], {
      ...options,
      parseMode: "MarkdownV2",
      // Only the lead message carries the reply-to/notification behaviour
      // the caller asked for; continuation pages are silent follow-ons in
      // the same chat/topic rather than N separate notifications.
      replyToMessageId: isFirst ? options.replyToMessageId : undefined,
      disableNotification: isFirst ? options.disableNotification : true,
    });
    if (id === null) {
      return { ok: false, sentMessageIds: messageIds, failedAtPage: i };
    }
    messageIds.push(id);
  }
  return { ok: true, messageIds };
}
