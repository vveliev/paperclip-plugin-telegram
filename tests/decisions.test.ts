import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const sent: Array<{ text: string; inlineKeyboard?: unknown }> = [];
const apiCalls: Array<{ url: string; method?: string; body?: string }> = [];
let apiResponses: unknown[] = [];

vi.mock("../src/telegram-api.js", () => ({
  sendMessage: vi.fn(async (_c: unknown, _t: string, _chat: string, text: string, opts?: { inlineKeyboard?: unknown }) => {
    sent.push({ text, inlineKeyboard: opts?.inlineKeyboard });
    return { ok: true };
  }),
  escapeMarkdownV2: (s: string) => s,
}));

vi.mock("../src/paperclip-api.js", () => ({
  buildPaperclipAuthHeaders: (token?: string) => (token ? { Authorization: `Bearer ${token}` } : {}),
  fetchPaperclipApi: vi.fn(async (_ctx: unknown, url: string, init?: { method?: string; body?: string }) => {
    apiCalls.push({ url, method: init?.method, body: init?.body });
    const next = apiResponses.shift();
    return { json: async () => next };
  }),
}));

const {
  buildDecisionCallback,
  parseDecisionCallback,
  isDecisionCallback,
  buildDecisionKeyboard,
  applyDecisionCallback,
  sendDecisionList,
  fetchOpenDecisions,
} = await import("../src/decisions.js");

const ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;
const DEC_ID = "11111111-2222-4333-8444-555555555555";

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: DEC_ID,
    title: "Ship or hold?",
    body: "The release gate is red.",
    status: "open",
    options: [
      { id: "ship", label: "Ship it", style: "primary" },
      { id: "hold", label: "Hold", style: "destructive" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  apiCalls.length = 0;
  apiResponses = [];
});

describe("callback encoding", () => {
  it("round-trips decision id and option index", () => {
    const data = buildDecisionCallback(DEC_ID, 1);
    expect(isDecisionCallback(data)).toBe(true);
    expect(parseDecisionCallback(data)).toEqual({ decisionId: DEC_ID, optionIndex: 1 });
  });

  it("stays inside Telegram's 64-byte callback_data limit", () => {
    expect(Buffer.byteLength(buildDecisionCallback(DEC_ID, 7))).toBeLessThanOrEqual(64);
  });

  it("does not claim other handlers' callbacks", () => {
    expect(isDecisionCallback("approve_1")).toBe(false);
    expect(isDecisionCallback("wfc_abc_0")).toBe(false);
  });
});

describe("buildDecisionKeyboard", () => {
  it("renders one button per option", () => {
    const keyboard = buildDecisionKeyboard(decision())!;
    expect(keyboard.flat().map((b) => b.text)).toEqual(["✅ Ship it", "⚠️ Hold"]);
  });

  it("offers no buttons when the decision needs typed input", () => {
    // Buttons alone cannot supply input values, and submitting without them
    // would record an incomplete answer.
    expect(buildDecisionKeyboard(decision({ inputs: [{ id: "why" }] }))).toBeUndefined();
  });
});

describe("applyDecisionCallback", () => {
  it("resolves the option against the CURRENT decision and decides", async () => {
    apiResponses = [decision(), { ok: true }];

    const result = await applyDecisionCallback(ctx, buildDecisionCallback(DEC_ID, 0), "http://x", "chat-1", "tok");

    expect(result).toEqual({ ok: true, message: "Ship it" });
    const decideCall = apiCalls.at(-1)!;
    expect(decideCall.url).toContain(`/api/decisions/${DEC_ID}/decide`);
    expect(JSON.parse(decideCall.body!)).toMatchObject({ optionId: "ship" });
  });

  it("sends an idempotency key so a duplicate tap cannot apply effects twice", async () => {
    apiResponses = [decision(), { ok: true }];
    await applyDecisionCallback(ctx, buildDecisionCallback(DEC_ID, 0), "http://x", "chat-1", "tok");
    expect(JSON.parse(apiCalls.at(-1)!.body!).idempotencyKey).toBe(`telegram:chat-1:${DEC_ID}:ship`);
  });

  it("refuses when the decision was already decided elsewhere", async () => {
    apiResponses = [decision({ status: "decided" })];
    const result = await applyDecisionCallback(ctx, buildDecisionCallback(DEC_ID, 0), "http://x", "chat-1", "tok");
    expect(result).toEqual({ ok: false, message: "Already decided" });
    // Crucially, no decide call was made against the stale option set.
    expect(apiCalls.filter((c) => c.url.includes("/decide"))).toHaveLength(0);
  });

  it("refuses when the option index no longer exists", async () => {
    apiResponses = [decision({ options: [{ id: "only", label: "Only" }] })];
    const result = await applyDecisionCallback(ctx, buildDecisionCallback(DEC_ID, 5), "http://x", "chat-1", "tok");
    expect(result.ok).toBe(false);
    expect(apiCalls.filter((c) => c.url.includes("/decide"))).toHaveLength(0);
  });
});

describe("sendDecisionList", () => {
  it("says nothing is waiting when the queue is empty", async () => {
    await sendDecisionList(ctx, "tok", "chat-1", []);
    expect(sent.at(-1)?.text).toBe("Nothing is waiting on your input.");
  });

  it("caps the list and says how many were withheld", async () => {
    const many = Array.from({ length: 7 }, (_, i) => decision({ id: `${DEC_ID.slice(0, -1)}${i}`, title: `D${i}` }));
    await sendDecisionList(ctx, "tok", "chat-1", many, { limit: 2 });
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.text).toContain("and 5 more");
  });
});

describe("fetchOpenDecisions", () => {
  it("asks only for open decisions", async () => {
    apiResponses = [[decision()]];
    const list = await fetchOpenDecisions(ctx, "http://x", "company-1", "tok");
    expect(apiCalls[0]!.url).toContain("/decisions?status=open");
    expect(list).toHaveLength(1);
  });

  it("returns an empty list when the API returns a non-array", async () => {
    apiResponses = [{ error: "nope" }];
    await expect(fetchOpenDecisions(ctx, "http://x", "company-1", "tok")).resolves.toEqual([]);
  });
});
