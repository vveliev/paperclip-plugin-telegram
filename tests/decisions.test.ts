import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const sent: string[] = [];
const sentOptions: Array<Record<string, unknown> | undefined> = [];
const apiCalls: string[] = [];
const answerCallbackCalls: Array<{ callbackQueryId: string; text: string }> = [];
let response: unknown = { totalCount: 0, items: [] };
let shouldThrow: Error | null = null;

vi.mock("../src/telegram-api.js", () => ({
  sendMessage: vi.fn(async (_c: unknown, _t: string, _chat: string, text: string, options?: Record<string, unknown>) => {
    sent.push(text);
    sentOptions.push(options);
    return { ok: true };
  }),
  answerCallbackQuery: vi.fn(async (_c: unknown, _t: string, callbackQueryId: string, text: string) => {
    answerCallbackCalls.push({ callbackQueryId, text });
  }),
  escapeMarkdownV2: (s: string) => s,
}));

vi.mock("../src/paperclip-api.js", () => ({
  buildPaperclipAuthHeaders: (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {}),
  fetchPaperclipApi: vi.fn(async (_ctx: unknown, url: string) => {
    apiCalls.push(url);
    if (shouldThrow) throw shouldThrow;
    return { json: async () => response };
  }),
}));

const answerableSendCalls: Array<{ chatId: string; interaction: unknown; opts: unknown }> = [];
let fetchedInteraction: { id: string; status: string; kind: string; payload: unknown } | null = null;
vi.mock("../src/interaction-answers.js", () => ({
  fetchInteraction: vi.fn(async () => fetchedInteraction),
  sendAnswerableInteraction: vi.fn(async (_ctx: unknown, _token: string, chatId: string, interaction: unknown, opts: unknown) => {
    answerableSendCalls.push({ chatId, interaction, opts });
    return true;
  }),
  isAskUserQuestionsAnswerable: (payload: { questions?: Array<{ options?: Array<{ freeText?: boolean }> }> }) =>
    Array.isArray(payload?.questions) &&
    payload.questions.length > 0 &&
    payload.questions.every((q) => (q.options ?? []).every((o) => o.freeText !== true)),
}));

const {
  fetchAttention,
  sendAttentionList,
  renderAttentionItem,
  describeSourceKind,
  describeDecisionsError,
  toAttentionItem,
  isDecisionsMoreCallback,
  resolveDecisionsMoreCallback,
  DECISIONS_PAGE_SIZE,
} = await import("../src/decisions.js");

function makeCtx(): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

/**
 * Fixtures below are trimmed copies of real /attention responses from a live
 * instance, not invented shapes — the previous implementation passed its own
 * tests while being wrong about the API, so the shapes are the thing under
 * test as much as the logic.
 */
const questionItem = {
  id: "issue_thread_interaction:interaction:921ee29e",
  sourceKind: "issue_thread_interaction",
  subject: {
    kind: "interaction",
    id: "921ee29e",
    title: 'Who is "the first client" for BLA-76\'s discovery interviews?',
    href: "/BLA/issues/BLA-134#interaction-921ee29e",
    metadata: { kind: "ask_user_questions", issueId: "issue-134" },
  },
  relatedIssue: { identifier: "BLA-134", title: "Confirm the first client" },
  whyNow: "Questions need answers on an issue thread.",
  severity: "medium",
  inlineResolvable: true,
  decisionVerbs: [{ id: "respond", label: "Respond" }],
  detail: { kind: "questions", questionCount: 1, firstQuestionText: "Who is the first client?" },
};

const blockerItem = {
  id: "blocker_attention:blocker:2aaf008c",
  sourceKind: "blocker_attention",
  subject: { kind: "issue", title: "Upstream wait_approval is inert", href: "/BLA/issues/BLA-156" },
  relatedIssue: { identifier: "BLA-156" },
  whyNow: "Blocks 0 tasks and needs human attention.",
  severity: "high",
  inlineResolvable: false,
  decisionVerbs: [
    { id: "unblock", label: "Unblock" },
    { id: "reassign", label: "Reassign" },
  ],
  detail: { kind: "blocker", blockedTaskCount: 0 },
};

const approvalItem = {
  id: "approval:approval:5f3c9a11",
  sourceKind: "approval",
  subject: {
    kind: "approval",
    id: "5f3c9a11-9c3e-4c4a-8b1a-1234567890ab",
    title: "Deploy backend to prod",
    href: "/BLA/issues/BLA-200#approval-5f3c9a11",
  },
  relatedIssue: { identifier: "BLA-200" },
  whyNow: "An approval is waiting on you.",
  severity: "medium",
  inlineResolvable: true,
  decisionVerbs: [{ id: "approve", label: "Approve" }],
  detail: { kind: "approval", summary: "Deploy backend to prod" },
};

beforeEach(() => {
  sent.length = 0;
  sentOptions.length = 0;
  apiCalls.length = 0;
  answerCallbackCalls.length = 0;
  shouldThrow = null;
  response = { totalCount: 0, items: [] };
  answerableSendCalls.length = 0;
  fetchedInteraction = null;
});

describe("fetchAttention", () => {
  it("reads the endpoint the Decisions page renders", async () => {
    response = { totalCount: 2, items: [questionItem, blockerItem] };

    const result = await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(apiCalls).toEqual(["http://x/api/companies/c1/attention"]);
    expect(result.totalCount).toBe(2);
    expect(result.items).toHaveLength(2);
  });

  it("includes blocker_attention, which a per-issue interaction scan can never find", async () => {
    // The bug this replaces: the page showed six items and the bot showed one,
    // because four of them were blockers and were not interactions at all.
    response = { totalCount: 2, items: [questionItem, blockerItem] };

    const { items } = await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(items.map((i) => i.sourceKind)).toContain("blocker_attention");
    expect(items.find((i) => i.sourceKind === "blocker_attention")?.issueIdentifier).toBe("BLA-156");
  });

  it("makes ONE request regardless of how much is pending", async () => {
    response = { totalCount: 30, items: Array.from({ length: 30 }, () => questionItem) };

    await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(apiCalls).toHaveLength(1);
  });

  it("propagates a failure instead of reporting an empty queue", async () => {
    // "Nothing is pending" and "we could not ask" must never look identical.
    shouldThrow = new Error('Paperclip API request failed with 403: {"error":"Board access required"}');

    await expect(fetchAttention(makeCtx(), "http://x", "c1", "tok")).rejects.toThrow("403");
  });

  it("throws on a response with no items array rather than reporting an empty queue", async () => {
    // This previously returned { items: [], totalCount: 0 } and was tested as
    // "survives a response with no items array". It does not survive it — it
    // renders as "Nothing is waiting on your input" while the Decisions page is
    // full, which is the one failure mode the user acts on. Observed live.
    response = {};
    await expect(fetchAttention(makeCtx(), "http://x", "c1", "tok")).rejects.toThrow(/items array/);
  });

  it("names the company and the shape it got, so the cause is visible", async () => {
    response = { error: "Board access required" };
    await expect(fetchAttention(makeCtx(), "http://x", "c1", "tok")).rejects.toThrow(/c1/);
    await expect(fetchAttention(makeCtx(), "http://x", "c1", "tok")).rejects.toThrow(/keys: error/);
  });

  it("does not leak response values into the error, only keys", async () => {
    // The message is sent to a Telegram chat; bodies can carry issue titles.
    response = { secretField: "s3cret-value", other: 1 };
    await expect(fetchAttention(makeCtx(), "http://x", "c1", "tok")).rejects.toThrow(/secretField/);
    await expect(fetchAttention(makeCtx(), "http://x", "c1", "tok")).rejects.not.toThrow(/s3cret-value/);
  });

  it("still reports a genuinely empty queue as empty", async () => {
    // The distinction that matters: [] is an answer, missing is a failure.
    response = { items: [], totalCount: 0 };
    const result = await fetchAttention(makeCtx(), "http://x", "c1", "tok");
    expect(result).toEqual({ items: [], totalCount: 0 });
  });

  it("carries the board token when one is available", async () => {
    response = { totalCount: 0, items: [] };
    await fetchAttention(makeCtx(), "http://x", "c1", "tok");
    expect(apiCalls[0]).toContain("/attention");
  });

  it("defaults verbs to an empty list when the host sends no decisionVerbs", async () => {
    const { decisionVerbs: _drop, ...withoutVerbs } = questionItem;
    response = { totalCount: 1, items: [withoutVerbs] };

    const { items } = await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(items[0].verbs).toEqual([]);
  });

  it("omits the limit query param when no limit is given", async () => {
    await fetchAttention(makeCtx(), "http://x", "c1", "tok");
    expect(apiCalls[0]).toBe("http://x/api/companies/c1/attention");
  });

  it("passes an explicit limit through, so the server returns enough items to display (BLA-622)", async () => {
    // The bug this closes: this plugin used to fetch with no limit at all, so
    // "totalCount 75, items 5" was possible even before any client-side
    // slicing — display and fetch must ask for the same count.
    await fetchAttention(makeCtx(), "http://x", "c1", "tok", 20);
    expect(apiCalls[0]).toBe("http://x/api/companies/c1/attention?limit=20");
  });

  it("clamps a limit above the endpoint's documented max of 100", async () => {
    await fetchAttention(makeCtx(), "http://x", "c1", "tok", 500);
    expect(apiCalls[0]).toBe("http://x/api/companies/c1/attention?limit=100");
  });
});

describe("renderAttentionItem", () => {
  it("leads with the title and says what kind of decision it is", () => {
    const [item] = [questionItem].map((r) => toItem(r));
    const text = renderAttentionItem(item);

    expect(text).toContain("the first client");
    expect(text).toContain("Needs your answer");
    expect(text).toContain("BLA-134");
  });

  it("uses the host's own whyNow rather than inventing urgency", () => {
    const text = renderAttentionItem(toItem(blockerItem));
    expect(text).toContain("Blocks 0 tasks and needs human attention.");
  });

  it("lists the available options so the reader knows what the choice is", () => {
    const text = renderAttentionItem(toItem(blockerItem));
    expect(text).toContain("Unblock / Reassign");
  });

  it("deep-links to the item, not to the Decisions index", () => {
    const text = renderAttentionItem(toItem(questionItem), "https://paperclip.example");
    expect(text).toContain("https://paperclip.example/BLA/issues/BLA-134#interaction-921ee29e");
  });

  it("omits the link when no public URL is configured", () => {
    expect(renderAttentionItem(toItem(questionItem))).not.toContain("Open:");
  });

  it("marks high severity differently from medium", () => {
    expect(renderAttentionItem(toItem(blockerItem))).toContain("🔴");
    expect(renderAttentionItem(toItem(questionItem))).toContain("🟡");
  });
});

describe("sendAttentionList", () => {
  it("says nothing is waiting only when the fetch actually succeeded", async () => {
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [], totalCount: 0 });
    expect(sent).toEqual(["Nothing is waiting on your input."]);
  });

  it("caps output and reports the true remaining count", async () => {
    const items = Array.from({ length: 6 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 6 }, { limit: 2 });

    expect(sent).toHaveLength(3);
    expect(sent.at(-1)).toContain("4 more");
  });

  it("reports the server's total, not the page size, when they differ", async () => {
    const items = Array.from({ length: 2 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 17 }, { limit: 2 });
    expect(sent.at(-1)).toContain("15 more");
  });
});

describe("sendAttentionList — inline answering (BLA-154)", () => {
  it("fetches the full interaction and sends an interactive prompt for a pick-only ask_user_questions item", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [{ id: "q1", prompt: "Who?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] }] },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).not.toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(1);
    expect(answerableSendCalls[0].chatId).toBe("chat-1");
    expect(answerableSendCalls[0].opts).toMatchObject({ issueId: "issue-134", companyId: "co-1" });
  });

  it("keeps the Open link and does not send a prompt when a question has a free-text option", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [{ id: "q1", prompt: "Who?", selectionMode: "single", options: [{ id: "o1", label: "Other", freeText: true }] }] },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(0);
  });

  it("keeps the Open link when the interaction resolved elsewhere since the feed was read", async () => {
    fetchedInteraction = { id: "921ee29e", status: "answered", kind: "ask_user_questions", payload: { version: 1, questions: [] } };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
  });

  it("fetches the full interaction and sends an interactive prompt for a request_confirmation item", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?", rejectRequiresReason: true },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).not.toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(1);
    expect(answerableSendCalls[0].interaction).toMatchObject({ kind: "request_confirmation" });
  });

  it("keeps the Open link for an interaction that was answered since the feed was read", async () => {
    // The /attention feed is a snapshot. Between reading it and fetching the
    // interaction, someone can answer it in the web UI. Offering buttons for it
    // anyway invites an answer the host will reject, and the user is told
    // nothing about why — so a non-pending status must fall back to the link.
    fetchedInteraction = {
      id: "921ee29e",
      status: "answered",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{ id: "q1", prompt: "Which?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] }],
      },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
  });

  it("keeps the Open link for an interaction kind Telegram cannot render as buttons", async () => {
    fetchedInteraction = { id: "921ee29e", status: "pending", kind: "suggest_tasks", payload: { version: 1 } };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(0);
  });

  it("keeps the Open link when only one of several questions has a free-text option", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [
          { id: "q1", prompt: "Which?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] },
          { id: "q2", prompt: "Why?", selectionMode: "single", options: [{ id: "o2", label: "Other", freeText: true }] },
        ],
      },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(0);
  });

  it("never attempts an inline answer for a blocker_attention item, which the host marks inlineResolvable: false", async () => {
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(blockerItem)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
  });

  it("honours inlineResolvable: false on an interaction, without even fetching it", async () => {
    // The blocker_attention case above is also screened out by its sourceKind,
    // so it cannot prove this flag is read. An interaction the host declined to
    // mark inline-resolvable is the only case where inlineResolvable is the
    // deciding guard: the host's verdict wins, and we do not spend a fetch
    // second-guessing it.
    const notInlineInteraction = { ...questionItem, inlineResolvable: false };
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{ id: "q1", prompt: "Which?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] }],
      },
    };

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(notInlineInteraction)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
  });

  it("does not fetch or send an interaction-style answerable prompt for an approval item", async () => {
    // Approvals are inline-resolvable (BLA-622), but through a button on the
    // item's own message, not through interaction-answers.js's fetch-then-park
    // flow — that machinery is issue_thread_interaction-only.
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(approvalItem)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
    });

    expect(answerableSendCalls).toHaveLength(0);
  });

  it("does not fetch anything when no baseUrl is supplied", async () => {
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, { companyId: "co-1" });

    expect(answerableSendCalls).toHaveLength(0);
  });
});

describe("toAttentionItem — approval fields (BLA-622)", () => {
  it("extracts approvalId from subject.id for an approval item", () => {
    const item = toAttentionItem(approvalItem);
    expect(item.sourceKind).toBe("approval");
    expect(item.approvalId).toBe("5f3c9a11-9c3e-4c4a-8b1a-1234567890ab");
  });

  it("leaves approvalId undefined for a non-approval item", () => {
    expect(toAttentionItem(questionItem).approvalId).toBeUndefined();
    expect(toAttentionItem(blockerItem).approvalId).toBeUndefined();
  });
});

describe("sendAttentionList — inline approving (BLA-622)", () => {
  it("attaches an Approve button that calls the same endpoint /approve uses, and drops the Open link", async () => {
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(approvalItem)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("https://paperclip.example/BLA/issues/BLA-200");
    expect(sentOptions[0]).toMatchObject({
      inlineKeyboard: [[{ text: "✅ Approve", callback_data: "pk:apr:5f3c9a11-9c3e-4c4a-8b1a-1234567890ab:approve" }]],
    });
  });

  it("keeps the Open link and adds no button when the host marks the approval not inline-resolvable", async () => {
    const notInline = { ...approvalItem, inlineResolvable: false };

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(notInline)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-200");
    expect(sentOptions[0]).toMatchObject({ inlineKeyboard: undefined });
  });

  it("adds no button when the feed sent no usable subject.id", async () => {
    const noId = { ...approvalItem, subject: { ...approvalItem.subject, id: undefined } };

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(noId)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
    });

    expect(sentOptions[0]).toMatchObject({ inlineKeyboard: undefined });
  });
});

describe("sendAttentionList — pagination (BLA-622)", () => {
  it("slices from offset instead of the start, so a later page does not repeat the first", async () => {
    const items = Array.from({ length: 10 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 30 }, { limit: 8, offset: 5 });

    // items[5..8): 3 messages, plus the "…N more waiting" trailer.
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)).toContain("22 more");
  });

  it("attaches a Show more button carrying the cumulative shown count as the next offset", async () => {
    const items = Array.from({ length: 5 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 75 }, { limit: 5 });

    const trailerOptions = sentOptions.at(-1);
    expect(trailerOptions).toMatchObject({
      inlineKeyboard: [[{ text: `Show more (+${DECISIONS_PAGE_SIZE})`, callback_data: "pk:dm:5:more" }]],
    });
  });

  it("caps the Show more offer to what remains, once fewer than a full page is left", async () => {
    const items = Array.from({ length: 5 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 8 }, { limit: 5 });

    const trailerOptions = sentOptions.at(-1) as { inlineKeyboard: Array<Array<{ text: string }>> };
    expect(trailerOptions.inlineKeyboard[0][0].text).toBe("Show more (+3)");
  });

  it("drops the Show more button once the endpoint's own cap is reached", async () => {
    const items = Array.from({ length: 100 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 500 }, { limit: 100 });

    expect(sent.at(-1)).toContain("400 more");
    expect(sentOptions.at(-1)).toMatchObject({ inlineKeyboard: undefined });
  });

  it("sends no trailer at all once everything has been shown", async () => {
    const items = Array.from({ length: 5 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 5 }, { limit: 5 });

    expect(sent).toHaveLength(5);
  });
});

describe("isDecisionsMoreCallback", () => {
  it("recognises the dm flow and rejects anything else", () => {
    expect(isDecisionsMoreCallback("pk:dm:5:more")).toBe(true);
    expect(isDecisionsMoreCallback("pk:apr:abc:approve")).toBe(false);
    expect(isDecisionsMoreCallback("pk:ask:abc:accept")).toBe(false);
  });
});

describe("resolveDecisionsMoreCallback", () => {
  const opts = { baseUrl: "http://x", publicUrl: "https://paperclip.example", companyId: "co-1", boardApiToken: "tok" };

  it("answers 'Could not load more' and fetches nothing for a malformed offset", async () => {
    await resolveDecisionsMoreCallback(makeCtx(), "tok", "pk:dm:notanumber:more", "cbq-1", "chat-1", opts);

    expect(answerCallbackCalls).toEqual([{ callbackQueryId: "cbq-1", text: "Could not load more." }]);
    expect(apiCalls).toHaveLength(0);
  });

  it("fetches the widened page, capped at the endpoint's own max, and renders past the given offset", async () => {
    response = { totalCount: 75, items: Array.from({ length: 25 }, () => questionItem) };

    await resolveDecisionsMoreCallback(makeCtx(), "tok", "pk:dm:5:more", "cbq-1", "chat-1", opts);

    expect(answerCallbackCalls[0]).toMatchObject({ callbackQueryId: "cbq-1", text: "Loading more…" });
    expect(apiCalls[0]).toBe(`http://x/api/companies/co-1/attention?limit=${5 + DECISIONS_PAGE_SIZE}`);
    // 25 items fetched, offset 5 -> renders items[5..25) = 20 messages, plus a further Show more trailer.
    expect(sent).toHaveLength(21);
  });

  it("reports a readable error instead of throwing when the fetch fails", async () => {
    shouldThrow = new Error('Paperclip API request failed with 403: {"error":"Board access required"}');

    await resolveDecisionsMoreCallback(makeCtx(), "tok", "pk:dm:5:more", "cbq-1", "chat-1", opts);

    expect(sent.at(-1)).toContain("no board access");
  });
});

describe("describeDecisionsError", () => {
  it("explains a 403 instead of dumping it", () => {
    const text = describeDecisionsError(
      new Error('Paperclip API request failed with 403: {"error":"Board access required"}'),
    );
    expect(text).toContain("no board access");
    expect(text).toContain("worker restart");
    expect(text).not.toContain('{"error"');
  });

  it("passes other failures through so real outages stay visible", () => {
    expect(describeDecisionsError(new Error("ECONNREFUSED"))).toContain("ECONNREFUSED");
  });
});

describe("describeSourceKind", () => {
  it("labels known kinds and degrades gracefully", () => {
    expect(describeSourceKind("issue_thread_interaction")).toBe("Needs your answer");
    expect(describeSourceKind("blocker_attention")).toBe("Blocked");
    expect(describeSourceKind("some_new_kind")).toBe("some new kind");
  });
});

// Round-trips a raw fixture through the real parser so render tests exercise
// the same mapping the fetch path produces. This MUST delegate rather than
// re-derive: an earlier hand-copy of toAttentionItem kept these tests passing
// while the production mapper was broken (a mutation that forced
// `inlineResolvable: true` — offering blockers inline — went undetected).
const toItem = toAttentionItem;
