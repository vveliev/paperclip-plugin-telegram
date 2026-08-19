import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleDiscussToolCall, handleAcpOutput } from "../src/acp-bridge.js";

let sentMessages: Array<{ chatId: string; text: string }> = [];
let stateStore: Record<string, unknown> = {};
let emittedEvents: Array<{ event: string; companyId: string; payload: unknown }> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 100;
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
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit: vi.fn(async (e: string, c: string, p: unknown) => { emittedEvents.push({ event: e, companyId: c, payload: p }); }), on: vi.fn() },
    agents: {
      list: vi.fn(async () => []),
      sessions: { create: vi.fn(), close: vi.fn() },
    },
    issues: { create: vi.fn(), update: vi.fn() },
    projects: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  emittedEvents = [];
});

// `ctx.events.emit` is a host RPC (Promise<void>). This runs inside
// handleUpdate's call graph, so an uncaught rejection would wedge Telegram
// polling for every chat — it must be logged, not left to propagate or drop.
describe("handleDiscussToolCall - events.emit rejection is caught, not dropped or propagated", () => {
  it("logs and swallows a rejected acp-spawn emit for an auto-spawned discussion target", async () => {
    const ctx = mockCtx();
    (ctx.events.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host RPC unavailable"));
    stateStore["sessions_chat-1_42"] = []; // no existing target session -> auto-spawn

    const result = await handleDiscussToolCall(ctx, "token", {
      targetAgent: "tester",
      topic: "review",
      initialMessage: "please review this",
      chatId: "chat-1",
      threadId: 42,
    }, "company-1", "agent-1");

    expect(JSON.parse(result.content!).status).toBe("started");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit acp-spawn for auto-spawned discussion target",
      expect.objectContaining({ chatId: "chat-1", error: expect.stringContaining("host RPC unavailable") }),
    );
  });

  it("logs and swallows a rejected acp-spawn emit for the discussion's initial message to an existing ACP session", async () => {
    const ctx = mockCtx();
    (ctx.events.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host RPC unavailable"));
    stateStore["sessions_chat-1_42"] = [{
      sessionId: "s1",
      agentId: "a1",
      agentName: "tester",
      agentDisplayName: "Tester",
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];

    const result = await handleDiscussToolCall(ctx, "token", {
      targetAgent: "tester",
      topic: "review",
      initialMessage: "please review this",
      chatId: "chat-1",
      threadId: 42,
    }, "company-1", "agent-1");

    expect(JSON.parse(result.content!).status).toBe("started");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit acp-spawn for discussion start",
      expect.objectContaining({ sessionId: "s1", error: expect.stringContaining("host RPC unavailable") }),
    );
  });
});

// checkConversationLoopContinuation runs once per discussion turn, inside
// handleAcpOutput's call graph off the ACP output event — reachable from
// handleUpdate the same way. A rejection here must not stall the discussion
// loop by throwing mid-turn.
describe("checkConversationLoopContinuation (via handleAcpOutput) - events.emit rejection is caught, not dropped or propagated", () => {
  it("logs and swallows a rejected acp-spawn emit for a discussion turn, and still advances the loop", async () => {
    const ctx = mockCtx();

    stateStore["chat_chat-1"] = { companyId: "company-1" };
    stateStore["sessions_chat-1_42"] = [
      {
        sessionId: "initiator-session",
        agentId: "agent-1",
        agentName: "builder",
        agentDisplayName: "Builder",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
      {
        sessionId: "target-session",
        agentId: "agent-2",
        agentName: "tester",
        agentDisplayName: "Tester",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
    ];
    stateStore["loop_chat-1_42"] = {
      loopId: "loop-1",
      initiatorSessionId: "initiator-session",
      targetSessionId: "target-session",
      initiatorAgent: "Builder",
      targetAgent: "Tester",
      topic: "review",
      maxTurns: 10,
      currentTurn: 0,
      lastOutputHash: null,
      previousOutputHash: null,
      status: "active",
      chatId: "chat-1",
      threadId: 42,
    };

    (ctx.events.emit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host RPC unavailable"));

    await expect(handleAcpOutput(ctx, "token", {
      sessionId: "initiator-session", type: "text",
      chatId: "chat-1",
      threadId: 42,
      text: "turn one output",
    })).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit acp-spawn for discussion turn",
      expect.objectContaining({ sessionId: "target-session", error: expect.stringContaining("host RPC unavailable") }),
    );
    // The rejection must not have aborted the turn: the loop still advanced.
    const loop = stateStore["loop_chat-1_42"] as Record<string, unknown>;
    expect(loop.currentTurn).toBe(1);
  });
});
