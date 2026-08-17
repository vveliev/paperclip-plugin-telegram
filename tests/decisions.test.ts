import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const sent: string[] = [];
const apiCalls: string[] = [];
let interactionsByIssue: Record<string, unknown[]> = {};

vi.mock("../src/telegram-api.js", () => ({
  sendMessage: vi.fn(async (_c: unknown, _t: string, _chat: string, text: string) => {
    sent.push(text);
    return { ok: true };
  }),
  escapeMarkdownV2: (s: string) => s,
}));

vi.mock("../src/paperclip-api.js", () => ({
  buildPaperclipAuthHeaders: (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {}),
  fetchPaperclipApi: vi.fn(async (_ctx: unknown, url: string) => {
    apiCalls.push(url);
    const issueId = url.match(/\/issues\/([^/]+)\/interactions/)?.[1] ?? "";
    if (issueId === "boom") throw new Error("unreadable");
    return { json: async () => interactionsByIssue[issueId] ?? [] };
  }),
}));

const answerableSendCalls: Array<{ chatId: string; interaction: unknown; opts: unknown }> = [];
vi.mock("../src/interaction-answers.js", () => ({
  sendAnswerableInteraction: vi.fn(async (_ctx: unknown, _token: string, chatId: string, interaction: unknown, opts: unknown) => {
    answerableSendCalls.push({ chatId, interaction, opts });
    return true;
  }),
  isAskUserQuestionsAnswerable: (payload: { questions?: Array<{ options?: Array<{ freeText?: boolean }> }> }) =>
    Array.isArray(payload?.questions) &&
    payload.questions.length > 0 &&
    payload.questions.every((q) => (q.options ?? []).every((o) => o.freeText !== true)),
}));

const { fetchPendingInteractions, sendPendingList, renderPendingInteraction, describeKind, isAnswerableInline } =
  await import("../src/decisions.js");

function makeCtx(issues: Array<{ id: string; identifier?: string }>): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    issues: { list: vi.fn(async () => issues) },
  } as unknown as PluginContext;
}

function interaction(over: Record<string, unknown> = {}) {
  return {
    id: "int-1",
    kind: "ask_user_questions",
    status: "pending",
    title: 'Who is "the first client"?',
    summary: "BLA-76 references a first client that is not named anywhere.",
    ...over,
  };
}

beforeEach(() => {
  sent.length = 0;
  apiCalls.length = 0;
  interactionsByIssue = {};
  answerableSendCalls.length = 0;
});

describe("fetchPendingInteractions", () => {
  it("collects pending interactions across issues", async () => {
    interactionsByIssue = {
      i1: [interaction()],
      i2: [interaction({ id: "int-2", status: "answered" })],
    };
    const ctx = makeCtx([{ id: "i1", identifier: "BLA-134" }, { id: "i2", identifier: "BLA-2" }]);

    const { pending, scanned } = await fetchPendingInteractions(ctx, "http://x", "c1", "tok");

    // Only the pending one; "answered" is history, not a queue item.
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ issueIdentifier: "BLA-134", kind: "ask_user_questions" });
    expect(scanned).toBe(2);
  });

  it("does not query /decisions — that endpoint is a different, empty feature", async () => {
    interactionsByIssue = { i1: [interaction()] };
    await fetchPendingInteractions(makeCtx([{ id: "i1" }]), "http://x", "c1", "tok");
    expect(apiCalls.every((u) => u.includes("/interactions"))).toBe(true);
    expect(apiCalls.some((u) => /\/decisions(\?|$)/.test(u))).toBe(false);
  });

  it("survives an unreadable issue rather than failing the whole command", async () => {
    interactionsByIssue = { ok1: [interaction()] };
    const ctx = makeCtx([{ id: "boom" }, { id: "ok1" }]);
    const { pending } = await fetchPendingInteractions(ctx, "http://x", "c1", "tok");
    expect(pending).toHaveLength(1);
  });

  it("bounds how many issues it scans", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `i${i}` }));
    const ctx = makeCtx(many);
    await fetchPendingInteractions(ctx, "http://x", "c1", "tok", 10);
    expect((ctx.issues.list as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ companyId: "c1", limit: 10 });
  });
});

describe("sendPendingList", () => {
  it("says how far it looked when nothing is pending", async () => {
    // "Nothing pending" is only trustworthy if it says what it checked.
    await sendPendingList(makeCtx([]), "tok", "chat-1", { pending: [], scanned: 30 });
    expect(sent.at(-1)).toContain("30 most recent issues");
  });

  it("caps output and reports the remainder", async () => {
    const pending = Array.from({ length: 7 }, (_, i) => ({
      id: `x${i}`, issueId: `i${i}`, issueIdentifier: `BLA-${i}`,
      kind: "ask_user_questions", title: `Q${i}`, summary: null, status: "pending",
    }));
    await sendPendingList(makeCtx([]), "tok", "chat-1", { pending, scanned: 30 }, { limit: 2 });
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)).toContain("5 more");
  });
});

describe("renderPendingInteraction", () => {
  it("shows the kind and the issue it belongs to", () => {
    const text = renderPendingInteraction({
      id: "1", issueId: "i1", issueIdentifier: "BLA-134",
      kind: "ask_user_questions", title: "Who is the first client?",
      summary: "Not named anywhere.", status: "pending",
    });
    expect(text).toContain("Who is the first client?");
    expect(text).toContain("Question");
    expect(text).toContain("BLA-134");
  });

  it("links out rather than pretending buttons can answer a form", () => {
    const text = renderPendingInteraction(
      { id: "1", issueId: "i1", issueIdentifier: "BLA-134", kind: "ask_user_questions", title: "Q", status: "pending" },
      "https://paperclip.example",
    );
    expect(text).toContain("https://paperclip.example/decisions");
  });
});

describe("describeKind", () => {
  it("labels known kinds and degrades gracefully", () => {
    expect(describeKind("ask_user_questions")).toBe("Question");
    expect(describeKind("request_confirmation")).toBe("Confirmation");
    expect(describeKind("some_new_kind")).toBe("some new kind");
  });
});

describe("isAnswerableInline", () => {
  const base = { id: "1", issueId: "i1", kind: "ask_user_questions", title: "Q", status: "pending" };

  it("is true for a pick-only ask_user_questions payload", () => {
    expect(isAnswerableInline({
      ...base,
      payload: { version: 1, questions: [{ id: "q1", prompt: "?", selectionMode: "single", options: [{ id: "o1", label: "A" }] }] },
    })).toBe(true);
  });

  it("is false when a question carries a free-text option — that still needs the web UI", () => {
    expect(isAnswerableInline({
      ...base,
      payload: { version: 1, questions: [{ id: "q1", prompt: "?", selectionMode: "single", options: [{ id: "o1", label: "Other", freeText: true }] }] },
    })).toBe(false);
  });

  it("is true for a request_confirmation payload with a prompt", () => {
    expect(isAnswerableInline({ ...base, kind: "request_confirmation", payload: { version: 1, prompt: "Ship it?" } })).toBe(true);
  });

  it("is false for kinds this module does not know how to answer", () => {
    expect(isAnswerableInline({ ...base, kind: "suggest_tasks", payload: { version: 1, tasks: [] } })).toBe(false);
  });

  it("is false when there is no payload at all", () => {
    expect(isAnswerableInline({ ...base, payload: undefined })).toBe(false);
  });
});

describe("sendPendingList — answerable items", () => {
  it("sends an interactive prompt and omits the web-UI link for an answerable item", async () => {
    const pending = [{
      id: "int-1", issueId: "i1", issueIdentifier: "BLA-1", kind: "request_confirmation",
      title: "Ship it?", summary: null, status: "pending",
      payload: { version: 1, prompt: "Ship it?" },
    }];

    await sendPendingList(makeCtx([]), "tok", "chat-1", { pending, scanned: 30 }, {
      publicUrl: "https://paperclip.example",
      companyId: "co-1",
    });

    expect(sent[0]).not.toContain("https://paperclip.example/decisions");
    expect(answerableSendCalls).toHaveLength(1);
    expect(answerableSendCalls[0]!.chatId).toBe("chat-1");
    expect(answerableSendCalls[0]!.opts).toMatchObject({ issueId: "i1", companyId: "co-1" });
  });

  it("keeps the web-UI link and does not attempt an interactive prompt for an unanswerable item", async () => {
    const pending = [{
      id: "int-1", issueId: "i1", issueIdentifier: "BLA-1", kind: "ask_user_questions",
      title: "Who?", summary: null, status: "pending",
      payload: { version: 1, questions: [{ id: "q1", prompt: "?", selectionMode: "single", options: [{ id: "o1", label: "Other", freeText: true }] }] },
    }];

    await sendPendingList(makeCtx([]), "tok", "chat-1", { pending, scanned: 30 }, {
      publicUrl: "https://paperclip.example",
      companyId: "co-1",
    });

    expect(sent[0]).toContain("https://paperclip.example/decisions");
    expect(answerableSendCalls).toHaveLength(0);
  });
});
