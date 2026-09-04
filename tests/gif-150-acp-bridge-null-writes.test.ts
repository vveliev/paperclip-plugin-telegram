import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleAcpOutput, handleHandoffApproval, handleHandoffRejection } from "../src/acp-bridge.js";

/**
 * GIF-150 / BLA-606: writing a JS `null` through ctx.state.set hits a
 * NOT-NULL constraint on plugin_state.value_json at the platform layer and
 * throws (see command-registry.ts's ParkedWorkflow comment, and
 * interaction-answers.ts's use of ctx.state.delete instead). acp-bridge.ts
 * had five call sites still doing the null write. Every other mock in this
 * suite lets `state.set(key, null)` succeed silently, which is exactly why
 * this class of bug shipped unnoticed — none of them modeled the real
 * constraint. This file's mock does.
 */

let sentMessages: Array<{ chatId: string; text: string }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
let stateStore: Record<string, unknown> = {};
let nextMessageId = 100;

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return nextMessageId++;
    }),
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string) => {
      editedMessages.push({ chatId, messageId, text });
      return true;
    }),
  };
});

function notNullConstraintError() {
  return new Error(
    'insert or update on table "plugin_state" violates not-null constraint "plugin_state_value_json_not_null"',
  );
}

/** Simulates the real platform: writing null throws; delete actually removes the row. */
function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        if (value === null) throw notNullConstraintError();
        stateStore[key.stateKey] = value;
      }),
      delete: vi.fn(async (key: { stateKey: string }) => {
        delete stateStore[key.stateKey];
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    agents: { list: vi.fn().mockResolvedValue([]), sessions: { create: vi.fn(), close: vi.fn() } },
    issues: { create: vi.fn().mockResolvedValue({ id: "issue-1" }), update: vi.fn() },
    projects: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

function activeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "s1",
    agentId: "a1",
    agentName: "builder",
    agentDisplayName: "Builder",
    transport: "native",
    spawnedAt: "2026-01-01T00:00:00Z",
    status: "active",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  stateStore = {};
  nextMessageId = 100;
});

describe("GIF-150 site 1+2: output_speaker lock release (handleOutputSequencing, flushOutputQueue)", () => {
  it("releases the lock and flushes a queued second agent's output when the first agent's turn completes", async () => {
    stateStore["sessions_chat-1_42"] = [
      activeSession({ sessionId: "s1", agentDisplayName: "Builder" }),
      activeSession({ sessionId: "s2", agentDisplayName: "Tester" }),
    ];
    const ctx = mockCtx();

    // Builder takes the floor.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "building..." });
    // Tester queues behind Builder.
    await handleAcpOutput(ctx, "token", { sessionId: "s2", type: "text", chatId: "chat-1", threadId: 42, text: "waiting" });
    expect(sentMessages).toHaveLength(1);

    // Builder finishes. Before the fix, the speakerKey null-write here threw,
    // the lock was never released, and Tester's queued output stayed queued
    // forever -- this call would reject.
    await expect(
      handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "build complete" }),
    ).resolves.toBeUndefined();

    // Tester's queued message must have been flushed.
    expect(sentMessages.some((m) => m.text.includes("Tester") && m.text.includes("waiting"))).toBe(true);
    // The lock must have transferred to Tester (who hasn't finished their
    // turn), not stayed stuck on Builder -- a stale "s1" here would mean the
    // release+flush never actually ran and Tester was sent by some other path.
    expect(stateStore["output_speaker_chat-1_42"]).toBe("s2");
  });

  it("releases the lock recursively across a chain of already-finished queued turns", async () => {
    stateStore["sessions_chat-1_42"] = [
      activeSession({ sessionId: "s1", agentDisplayName: "Builder" }),
      activeSession({ sessionId: "s2", agentDisplayName: "Tester" }),
      activeSession({ sessionId: "s3", agentDisplayName: "Reviewer" }),
    ];
    const ctx = mockCtx();

    // Builder takes the floor and holds it (not done).
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "building..." });
    // Tester's whole turn queues up behind Builder, already terminal.
    await handleAcpOutput(ctx, "token", { sessionId: "s2", type: "done", chatId: "chat-1", threadId: 42, text: "tests passed" });
    // Reviewer also queues behind Builder.
    await handleAcpOutput(ctx, "token", { sessionId: "s3", type: "text", chatId: "chat-1", threadId: 42, text: "reviewing" });
    expect(sentMessages).toHaveLength(1);

    // Builder finishes: releases the lock (site 1), flushes the queue, sends
    // Tester's already-done message, which must itself release the lock a
    // second time (site 2, inside flushOutputQueue) and keep flushing so
    // Reviewer's queued message goes out too. Before the fix, either release
    // throwing would strand Reviewer's output in the queue permanently.
    await expect(
      handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "build complete" }),
    ).resolves.toBeUndefined();

    expect(sentMessages.some((m) => m.text.includes("Tester") && m.text.includes("tests passed"))).toBe(true);
    expect(sentMessages.some((m) => m.text.includes("Reviewer") && m.text.includes("reviewing"))).toBe(true);
    // Tester's turn was already done, so the chain keeps releasing and
    // flushing until it reaches Reviewer, who hasn't finished -- the lock
    // should land there, not on Builder or Tester.
    expect(stateStore["output_speaker_chat-1_42"]).toBe("s3");
  });
});

describe("GIF-150 site 3: per-turn buffer cleanup (sendLabeledOutput) -- found during this review, not in the original four", () => {
  it("clears turn state on a terminal event without throwing, even for a single active agent", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "working" });
    // Before the fix, this threw inside sendLabeledOutput -- upstream of
    // both speaker-lock sites -- so even single-agent output would break on
    // every completed turn, not just multi-agent handoffs.
    await expect(
      handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "finished" }),
    ).resolves.toBeUndefined();

    expect(editedMessages[0]?.text).toContain("finished");
    expect(stateStore).not.toHaveProperty("output_turn_chat-1_42_s1");
  });
});

describe("GIF-150 sites 4+5: handoff cleanup (handleHandoffApproval, handleHandoffRejection)", () => {
  function pendingHandoff(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      handoffId: "h1",
      sourceSessionId: "s1",
      sourceAgent: "Builder",
      targetAgent: "tester",
      reason: "needs testing",
      contextSummary: "code is ready",
      chatId: "chat-1",
      threadId: 42,
      companyId: "company-1",
      ...overrides,
    };
  }

  // GIF-158 moved handoff parking onto parked-interactions.ts, whose row key
  // is `ho_<handoffId>` (an envelope, not the raw PendingHandoff) rather than
  // this test's original `handoff_<id>` — seed what `park()` would write.
  function seedParkedHandoff(overrides: Partial<Record<string, unknown>> = {}) {
    stateStore["ho_h1"] = { payload: pendingHandoff(overrides), createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
  }

  it("clears the pending handoff after approval without throwing", async () => {
    seedParkedHandoff();
    stateStore["sessions_chat-1_42"] = [
      activeSession({ sessionId: "s1", agentName: "builder", agentDisplayName: "Builder" }),
      activeSession({ sessionId: "s2", agentId: "a2", agentName: "tester", agentDisplayName: "Tester" }),
    ];
    const ctx = mockCtx();

    // These run outside handleCallbackQuery's try/catch in worker.ts, so a
    // throw here escapes to handleUpdate and freezes the polling offset for
    // every chat (not just this one) -- resolving cleanly is the whole point.
    await expect(
      handleHandoffApproval(ctx, "token", "h1", "alice", "cb-1", "chat-1", 99),
    ).resolves.toBeUndefined();

    expect(stateStore).not.toHaveProperty("ho_h1");
  });

  it("clears the pending handoff after rejection without throwing", async () => {
    seedParkedHandoff();
    const ctx = mockCtx();

    await expect(
      handleHandoffRejection(ctx, "token", "h1", "alice", "cb-1", "chat-1", 99),
    ).resolves.toBeUndefined();

    expect(sentMessages[0]?.text).toContain("rejected");
    expect(stateStore).not.toHaveProperty("ho_h1");
  });
});
