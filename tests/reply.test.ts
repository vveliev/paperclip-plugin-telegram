import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fitParts, sendFittedReply } from "../src/reply.js";
import type { MessagePart } from "../src/reply.js";
import { TELEGRAM_MESSAGE_MAX_LENGTH } from "../src/constants.js";

// This module is the one place allowed to compare rendered text
// against Telegram's real limit. These tests exist to prove the invariant
// the issue names directly -- "over-length provably cannot reach the API" --
// not just to exercise the happy path.

type FetchCall = { url: string; init: { body: string } };

let calls: FetchCall[] = [];
let responses: unknown[] = [];

function makeCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, init });
        const next = responses.shift() ?? { ok: true, result: { message_id: calls.length } };
        if (next instanceof Error) throw next;
        return { json: async () => next };
      }),
    },
    metrics: { write: vi.fn(async () => {}) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

beforeEach(() => {
  calls = [];
  responses = [];
});

describe("fitParts", () => {
  it("renders a single page when parts fit comfortably", () => {
    const parts: MessagePart[] = [
      { kind: "bold", value: "Title" },
      { kind: "text", value: "some body text" },
    ];
    const pages = fitParts(parts);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toBe("*Title*\n\nsome body text");
  });

  it("escapes MarkdownV2 special characters in every part kind", () => {
    const parts: MessagePart[] = [
      { kind: "text", value: "a.b" },
      { kind: "bold", value: "x_y" },
      { kind: "code", value: "a-b" },
      { kind: "link", text: "click.me", url: "https://example.com" },
      { kind: "list", items: ["one.", "two!"] },
    ];
    const [page] = fitParts(parts);
    expect(page).toContain("a\\.b");
    expect(page).toContain("*x\\_y*");
    expect(page).toContain("`a\\-b`");
    expect(page).toContain("[click\\.me](https://example.com)");
    expect(page).toContain("• one\\.");
    expect(page).toContain("• two\\!");
  });

  it("never produces a page longer than maxLen for content far past the limit", () => {
    const parts: MessagePart[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "text" as const,
      value: `paragraph number ${String(i)} with some words in it to take up space`,
    }));
    const pages = fitParts(parts);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
    }
    // Nothing was dropped: every paragraph's distinctive number shows up somewhere.
    const joined = pages.join("\n");
    for (let i = 0; i < 200; i++) {
      expect(joined).toContain(`paragraph number ${String(i)} `);
    }
  });

  it("hard-splits a single unit with no spaces at all, rather than looping or overflowing", () => {
    const parts: MessagePart[] = [{ kind: "text", value: "x".repeat(10_000) }];
    const pages = fitParts(parts, 100);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(100);
    }
    expect(pages.join("").length).toBe(10_000);
  });

  it("word-splits a single long unit at whitespace boundaries", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${String(i)}`);
    const parts: MessagePart[] = [{ kind: "text", value: words.join(" ") }];
    const pages = fitParts(parts, 50);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(50);
    }
    // No word got split in half.
    for (const word of words) {
      expect(pages.some((p) => p.includes(word))).toBe(true);
    }
  });
});

describe("sendFittedReply", () => {
  it("requires an explicit overflow policy at the type level (no default)", () => {
    // @ts-expect-error -- overflow is a required parameter, not optional.
    void (() => sendFittedReply(makeCtx(), "tok", "chat-1", [{ kind: "text", value: "hi" }]));
  });

  it("sends a single message and always sets parseMode to MarkdownV2", async () => {
    const ctx = makeCtx();
    const result = await sendFittedReply(
      ctx,
      "tok",
      "chat-1",
      [{ kind: "text", value: "hello" }],
      "split",
    );

    expect(result).toEqual({ ok: true, messageIds: [1] });
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toMatchObject({ text: "hello", parse_mode: "MarkdownV2" });
  });

  it("threads replyToMessageId and messageThreadId through to the underlying send", async () => {
    const ctx = makeCtx();
    await sendFittedReply(ctx, "tok", "chat-1", [{ kind: "text", value: "hi" }], "split", {
      replyToMessageId: 42,
      messageThreadId: 7,
    });

    expect(bodyOf(calls[0])).toMatchObject({ reply_to_message_id: 42, message_thread_id: 7 });
  });

  describe("split", () => {
    it("sends one message per fitted page, none over Telegram's limit", async () => {
      const ctx = makeCtx();
      const parts: MessagePart[] = Array.from({ length: 150 }, (_, i) => ({
        kind: "text" as const,
        value: `line ${String(i)} `.repeat(10),
      }));

      const result = await sendFittedReply(ctx, "tok", "chat-1", parts, "split");

      expect(result.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        const text = bodyOf(call).text as string;
        expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
      }
    });

    it("marks continuation pages silent and non-reply, keeping only the lead message's reply-to", async () => {
      const ctx = makeCtx();
      const parts: MessagePart[] = Array.from({ length: 150 }, (_, i) => ({
        kind: "text" as const,
        value: `line ${String(i)} `.repeat(10),
      }));

      await sendFittedReply(ctx, "tok", "chat-1", parts, "split", { replyToMessageId: 99 });

      expect(calls.length).toBeGreaterThan(1);
      expect(bodyOf(calls[0])).toMatchObject({ reply_to_message_id: 99 });
      expect(bodyOf(calls[0])).not.toHaveProperty("disable_notification");
      for (const call of calls.slice(1)) {
        expect(bodyOf(call)).not.toHaveProperty("reply_to_message_id");
        expect(bodyOf(call)).toMatchObject({ disable_notification: true });
      }
    });

    it("stops at the first failed page instead of sending the rest of a broken reply", async () => {
      responses = [
        { ok: true, result: { message_id: 1 } },
        // sendMessage itself retries a failed MarkdownV2 send once as plain
        // text before giving up, so the second page needs two consecutive
        // failures to actually surface as a null.
        { ok: false, description: "chat not found" },
        { ok: false, description: "chat not found" },
      ];
      const ctx = makeCtx();
      const parts: MessagePart[] = Array.from({ length: 150 }, (_, i) => ({
        kind: "text" as const,
        value: `line ${String(i)} `.repeat(10),
      }));

      const result = await sendFittedReply(ctx, "tok", "chat-1", parts, "split");

      expect(result).toEqual({ ok: false, sentMessageIds: [1], failedAtPage: 1 });
      // The lead page, plus the second page's initial attempt and its
      // plain-text retry -- not the full page count -- confirms the loop
      // actually stopped rather than swallowing further failures.
      expect(calls).toHaveLength(3);
    });
  });

  describe("truncate", () => {
    it("fits everything into exactly one message when it's already short", async () => {
      const ctx = makeCtx();
      await sendFittedReply(ctx, "tok", "chat-1", [{ kind: "text", value: "short reply" }], "truncate");

      expect(calls).toHaveLength(1);
      expect(bodyOf(calls[0]).text).toBe("short reply");
    });

    it("truncates at a word boundary and never exceeds the limit", async () => {
      const ctx = makeCtx();
      const parts: MessagePart[] = Array.from({ length: 500 }, (_, i) => ({
        kind: "text" as const,
        value: `word${String(i)}`,
      }));

      await sendFittedReply(ctx, "tok", "chat-1", parts, "truncate");

      expect(calls).toHaveLength(1);
      const text = bodyOf(calls[0]).text as string;
      expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
      expect(text.endsWith("...")).toBe(true);
    });
  });

  describe("paginate", () => {
    it("captions each page with its position, none over the limit", async () => {
      const ctx = makeCtx();
      const parts: MessagePart[] = Array.from({ length: 200 }, (_, i) => ({
        kind: "text" as const,
        value: `entry ${String(i)} `.repeat(10),
      }));

      const result = await sendFittedReply(ctx, "tok", "chat-1", parts, "paginate");

      expect(result.ok).toBe(true);
      expect(calls.length).toBeGreaterThan(1);
      const total = calls.length;
      calls.forEach((call, i) => {
        const text = bodyOf(call).text as string;
        expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
        expect(text).toContain(`Page ${String(i + 1)} of ${String(total)}`);
      });
    });

    it("does not caption a reply that already fits on one page", async () => {
      const ctx = makeCtx();
      await sendFittedReply(ctx, "tok", "chat-1", [{ kind: "text", value: "short" }], "paginate");

      expect(calls).toHaveLength(1);
      expect(bodyOf(calls[0]).text).toBe("short");
    });
  });

  it("throws rather than silently sending nothing when parts render no content", async () => {
    const ctx = makeCtx();
    await expect(sendFittedReply(ctx, "tok", "chat-1", [{ kind: "text", value: "" }], "split")).rejects.toThrow(
      /rendered no content/,
    );
    expect(calls).toHaveLength(0);
  });
});
