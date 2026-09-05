import { describe, it, expect, vi, beforeEach } from "vitest";
import { EscalationManager } from "../src/escalation.js";
import type { EscalationEvent } from "../src/escalation.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};
let emittedEvents: Array<{ event: string; companyId: string; payload: unknown }> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 42;
    }),
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => {
      editedMessages.push({ chatId, messageId, text, options });
      return true;
    }),
  };
});

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
      delete: vi.fn(async (key: { stateKey: string }) => {
        delete stateStore[key.stateKey];
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      emit: vi.fn(async (event: string, companyId: string, payload: unknown) => {
        emittedEvents.push({ event, companyId, payload });
      }),
    },
    agents: {
      sessions: {
        sendMessage: vi.fn(),
        close: vi.fn(),
      },
    },
  } as unknown as PluginContext;
}

function makeEvent(overrides: Partial<EscalationEvent> = {}): EscalationEvent {
  return {
    escalationId: "esc-001",
    agentId: "agent-1",
    companyId: "company-1",
    reason: "low_confidence",
    context: {
      conversationHistory: [{ role: "user", text: "Help me" }],
      agentReasoning: "I'm not sure about this",
      suggestedActions: ["Forward to support"],
      suggestedReply: "Let me connect you with a human.",
      confidenceScore: 0.3,
    },
    timeout: {
      durationMs: 60000,
      defaultAction: "defer",
    },
    originChatId: "origin-chat-1",
    originThreadId: "origin-thread-1",
    originMessageId: "origin-msg-1",
    transport: "native",
    sessionId: "session-1",
    ...overrides,
  };
}

/**
 * Parks an escalation through the real `create()` path (not raw state
 * seeding) so these tests exercise the same park/liveness/expiry machinery
 * production code goes through — see parked-interactions.ts. Passing a
 * negative `durationMs` is how a test manufactures an already-expired park:
 * `expiresAt = Date.now() + durationMs` lands in the past immediately.
 */
async function createEscalation(ctx: PluginContext, overrides: Partial<EscalationEvent> = {}, chatId = "esc-chat-1") {
  const manager = new EscalationManager();
  const event = makeEvent(overrides);
  await manager.create(ctx, "token", event, chatId);
  return { manager, event };
}

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  stateStore = {};
  emittedEvents = [];
});

describe("EscalationManager.create", () => {
  it("sends an escalation message with MarkdownV2 formatting", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].chatId).toBe("esc-chat-1");
    expect(sentMessages[0].text).toContain("Escalation");
    expect(sentMessages[0].text).toContain("Low Confidence");
    expect(sentMessages[0].options).toMatchObject({ parseMode: "MarkdownV2" });
  });

  it("includes confidence score percentage", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: [],
      confidenceScore: 0.72,
    }}), "esc-chat-1");

    expect(sentMessages[0].text).toContain("72%");
  });

  it("omits confidence when not provided", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: [],
      confidenceScore: undefined,
    }}), "esc-chat-1");

    expect(sentMessages[0].text).not.toContain("%");
  });

  it("includes suggested reply button when suggestedReply is provided", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const keyboard = sentMessages[0].options?.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(keyboard).toBeDefined();
    // First row should be the suggested reply button
    const suggestedBtn = keyboard[0].find((b: { text: string }) => b.text === "Send Suggested Reply");
    expect(suggestedBtn).toBeDefined();
    expect(suggestedBtn!.callback_data).toBe("pk:esc:esc-001:suggested");
  });

  it("omits suggested reply button when no suggestedReply", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: [],
      suggestedReply: undefined,
    }}), "esc-chat-1");

    const keyboard = sentMessages[0].options?.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    const allButtons = keyboard.flat();
    expect(allButtons.find((b: { text: string }) => b.text === "Send Suggested Reply")).toBeUndefined();
  });

  it("always includes Reply, Override, and Dismiss buttons", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const keyboard = sentMessages[0].options?.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    const allButtons = keyboard.flat();
    expect(allButtons.find((b: { text: string }) => b.text === "Reply")).toBeDefined();
    expect(allButtons.find((b: { text: string }) => b.text === "Override")).toBeDefined();
    expect(allButtons.find((b: { text: string }) => b.text === "Dismiss")).toBeDefined();
  });

  it("parks the escalation under the shared codec's row key, keyed by escalationId", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const row = stateStore["esc_esc-001"] as { payload: Record<string, unknown> } | undefined;
    expect(row).toBeDefined();
    expect(row!.payload.escalationId).toBe("esc-001");
    expect(row!.payload.agentId).toBe("agent-1");
    expect(row!.payload.reason).toBe("low_confidence");
  });

  it("adds escalation id to the flow's live-key index (parked-interactions.ts), so the sweeper can find it", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent(), "esc-chat-1");

    const index = stateStore["index_esc"] as string[];
    expect(index).toContain("esc-001");
  });

  it("appends to an existing index instead of clobbering it", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ escalationId: "esc-000" }), "esc-chat-1");
    await manager.create(ctx, "token", makeEvent({ escalationId: "esc-001" }), "esc-chat-1");

    const index = stateStore["index_esc"] as string[];
    expect(index).toEqual(["esc-000", "esc-001"]);
  });

  it("includes suggested actions in message", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ context: {
      conversationHistory: [],
      agentReasoning: "test",
      suggestedActions: ["Action 1", "Action 2"],
    }}), "esc-chat-1");

    expect(sentMessages[0].text).toContain("Action 1");
    expect(sentMessages[0].text).toContain("Action 2");
  });

  it("maps all four escalation reasons to labels", async () => {
    const manager = new EscalationManager();

    for (const [reason, label] of [
      ["low_confidence", "Low Confidence"],
      ["explicit_request", "User Requested Human"],
      ["policy_violation", "Policy Violation"],
      ["unknown_intent", "Unknown Intent"],
    ] as const) {
      sentMessages = [];
      const ctx = mockCtx();
      await manager.create(ctx, "token", makeEvent({ reason }), "chat");
      expect(sentMessages[0].text).toContain(label.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&"));
    }
  });

  it("stores transport and sessionId in escalation state", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();
    await manager.create(ctx, "token", makeEvent({ transport: "acp", sessionId: "sess-acp" }), "esc-chat-1");

    const row = stateStore["esc_esc-001"] as { payload: Record<string, unknown> };
    expect(row.payload.transport).toBe("acp");
    expect(row.payload.sessionId).toBe("sess-acp");
  });
});

describe("EscalationManager.handleCallback - callback data parsing", () => {
  it("handles esc_suggested action with suggested reply, and clears the park", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx);

    await manager.handleCallback(ctx, "token", "suggested", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    // Resolved: the row is gone rather than flipped to a "resolved" sentinel
    // (parked-interactions.ts's liveness rule is "the park exists").
    expect(stateStore["esc_esc-001"]).toBeUndefined();
  });

  it("handles esc_reply action by editing message to awaiting reply, without resolving", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx);

    await manager.handleCallback(ctx, "token", "reply", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    expect(editedMessages.length).toBe(1);
    expect(editedMessages[0].text).toContain("Awaiting Your Reply");
    // Still parked — "Reply" only prompts for a follow-up message, it does not resolve.
    expect(stateStore["esc_esc-001"]).toBeDefined();
  });

  it("handles esc_dismiss action", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx);

    await manager.handleCallback(ctx, "token", "dismiss", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    expect(stateStore["esc_esc-001"]).toBeUndefined();
  });

  it("ignores callback for an already-resolved escalation", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx);
    await manager.handleCallback(ctx, "token", "dismiss", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);
    editedMessages = [];
    emittedEvents = [];

    // A redelivered tap after the row is cleared is indistinguishable from
    // one that never existed — both take the same early-return path.
    await manager.handleCallback(ctx, "token", "dismiss", "esc-001", "user-1", "cbq-1", "esc-chat-1", 42);

    expect(editedMessages.length).toBe(0);
    expect(emittedEvents.length).toBe(0);
  });

  it("ignores callback for non-existent escalation", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    await manager.handleCallback(ctx, "token", "dismiss", "nonexistent", "user-1", "cbq-1", "chat", 42);

    expect(editedMessages.length).toBe(0);
  });
});

describe("EscalationManager.checkTimeouts", () => {
  it("times out escalation that has exceeded timeout", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx, { timeout: { durationMs: -60000, defaultAction: "defer" } });

    await manager.checkTimeouts(ctx, "token");

    expect(editedMessages.length).toBe(1);
    expect(editedMessages[0].text).toContain("Timed Out");
    // Cleared, not left behind under a "timed_out" sentinel.
    expect(stateStore["esc_esc-001"]).toBeUndefined();
  });

  it("does not time out escalation that has not exceeded timeout", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx, { timeout: { durationMs: 60000, defaultAction: "defer" } });

    await manager.checkTimeouts(ctx, "token");

    expect(editedMessages.length).toBe(0);
    expect(stateStore["esc_esc-001"]).toBeDefined();
  });

  it("auto-replies on timeout when defaultAction is auto_reply", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx, {
      timeout: { durationMs: -60000, defaultAction: "auto_reply" },
      context: {
        conversationHistory: [],
        agentReasoning: "test",
        suggestedActions: [],
        suggestedReply: "Auto response text",
      },
      originChatId: "origin-chat",
    });

    await manager.checkTimeouts(ctx, "token");

    // Should have sent auto-reply to origin chat
    expect(sentMessages.some(m => m.chatId === "origin-chat")).toBe(true);
  });

  it("removes only the timed-out escalation from the live-key index, leaving the other pending", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx, { escalationId: "esc-001", timeout: { durationMs: -60000, defaultAction: "defer" } });
    await createEscalation(ctx, { escalationId: "esc-002", timeout: { durationMs: 60000, defaultAction: "defer" } });

    await manager.checkTimeouts(ctx, "token");

    const index = stateStore["index_esc"] as string[];
    expect(index).not.toContain("esc-001");
    expect(index).toContain("esc-002");
  });

  it("does nothing when nothing is parked", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    await manager.checkTimeouts(ctx, "token");

    expect(editedMessages.length).toBe(0);
    expect(sentMessages.length).toBe(0);
  });

  it("emits escalation.timed_out event", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx, { timeout: { durationMs: -60000, defaultAction: "defer" } });

    await manager.checkTimeouts(ctx, "token");

    expect(emittedEvents.some(e => e.event === "escalation.timed_out")).toBe(true);
  });
});

describe("EscalationManager.respond", () => {
  it("resolves a pending escalation", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx);

    await manager.respond(ctx, "token", "esc-001", {
      escalationId: "esc-001",
      responderId: "user-1",
      responseText: "Here is the answer",
      action: "reply_to_customer",
    });

    expect(stateStore["esc_esc-001"]).toBeUndefined();
  });

  it("ignores respond for a non-pending (never created, or already resolved) escalation", async () => {
    const manager = new EscalationManager();
    const ctx = mockCtx();

    await manager.respond(ctx, "token", "esc-001", {
      escalationId: "esc-001",
      responderId: "user-1",
      responseText: "text",
      action: "reply_to_customer",
    });

    expect(editedMessages.length).toBe(0);
  });
});

// `ctx.events.emit` is a host RPC (Promise<void>) that the plugin cannot
// control. These prove a rejection is logged, not swallowed — and, just as
// important, that it does NOT propagate: this code runs inside
// handleUpdate's call graph and check-escalation-timeouts' job loop, and an
// uncaught throw either wedges Telegram polling for every chat or aborts
// the remaining companies' timeout checks for that tick.
describe("EscalationManager - events.emit rejection is caught, not dropped or propagated", () => {
  it("logs and swallows a rejected escalation.resolved emit", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx);
    (ctx.events.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host RPC unavailable"));

    await expect(
      manager.respond(ctx, "token", "esc-001", {
        escalationId: "esc-001",
        responderId: "user-1",
        responseText: "Here is the answer",
        action: "reply_to_customer",
      }),
    ).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit escalation.resolved",
      expect.objectContaining({ escalationId: "esc-001", error: expect.stringContaining("host RPC unavailable") }),
    );
    // The rejection must not have aborted resolve(): the park was still cleared.
    expect(stateStore["esc_esc-001"]).toBeUndefined();
  });

  it("logs and swallows a rejected escalation.timed_out emit", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx, { timeout: { durationMs: -60000, defaultAction: "defer" } });
    (ctx.events.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host RPC unavailable"));

    await expect(manager.checkTimeouts(ctx, "token")).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit escalation.timed_out",
      expect.objectContaining({ escalationId: "esc-001", error: expect.stringContaining("host RPC unavailable") }),
    );
    // The rejection must not have aborted checkTimeouts(): the park was still cleared.
    expect(stateStore["esc_esc-001"]).toBeUndefined();
  });

  it("logs and swallows a rejected acp-spawn emit when routing an escalation reply over ACP", async () => {
    const ctx = mockCtx();
    const { manager } = await createEscalation(ctx, { transport: "acp", sessionId: "sess-acp-1" });
    (ctx.events.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host RPC unavailable"));

    await expect(
      manager.respond(ctx, "token", "esc-001", {
        escalationId: "esc-001",
        responderId: "user-1",
        responseText: "Here is the answer",
        action: "reply_to_customer",
      }),
    ).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit acp-spawn for escalation reply",
      expect.objectContaining({ escalationId: "esc-001", sessionId: "sess-acp-1", error: expect.stringContaining("host RPC unavailable") }),
    );
    // The rejection on the ACP route must not have blocked the resolution event after it.
    expect(emittedEvents.some((e) => e.event === "escalation.resolved")).toBe(true);
  });
});
