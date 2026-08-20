import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleAcpOutput } from "../src/acp-bridge.js";
import { editMessage } from "../src/telegram-api.js";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};
let nextMessageId = 100;

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return nextMessageId++;
    }),
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => {
      editedMessages.push({ chatId, messageId, text, options });
      return true;
    }),
  };
});

function mockCtx(): PluginContext {
  return {
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
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
  vi.mocked(editMessage).mockClear();
});

describe("handleAcpOutput - chunking (regression: Telegram rejects messages over 4096 chars)", () => {
  it("splits output longer than the chunk limit into multiple sendMessage calls", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    const longText = "line\n".repeat(1000); // ~5000 chars, well over the 4000-char chunk budget

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: longText });

    expect(sentMessages.length).toBeGreaterThan(1);
    // No individual chunk may exceed Telegram's hard limit
    for (const msg of sentMessages) {
      expect(msg.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it("does not split output at or under the limit", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    const shortText = "all good here";

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: shortText });

    expect(sentMessages).toHaveLength(1);
  });

  it("writes the agent_msg reply-to mapping for every message opened, not only the last (regression: multi-chunk replies must route to the same agent from any chunk)", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    const longText = "line\n".repeat(1000);

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: longText });

    expect(sentMessages.length).toBeGreaterThan(1);
    for (let i = 0; i < sentMessages.length; i++) {
      const messageId = 100 + i;
      expect(stateStore[`agent_msg_chat-1_${messageId}`]).toEqual({ sessionId: "s1" });
    }
  });
});

describe("handleAcpOutput - accumulate/chunk/edit turn state", () => {
  // These events are spaced past the edit debounce window (§8) so each one
  // lands as its own edit — see the "flood control" describe block below for
  // what happens when events arrive faster than the debounce window.
  it("edits one message in place across N text events instead of sending N messages", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    vi.useFakeTimers();

    try {
      for (let i = 0; i < 5; i++) {
        await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: `line ${i}` });
        vi.advanceTimersByTime(1001);
      }
    } finally {
      vi.useRealTimers();
    }

    expect(sentMessages).toHaveLength(1);
    expect(editedMessages).toHaveLength(4);
    // The open message keeps accumulating every line, joined one-per-line.
    expect(editedMessages[3].text).toContain("line 0");
    expect(editedMessages[3].text).toContain("line 4");
    // Still open — not yet finalized.
    expect(editedMessages[3].text).toContain("🤖");
    expect(editedMessages[3].text).not.toContain("✅");
  });

  it("opens exactly one new message when the accumulated buffer crosses the 4000-char boundary mid-turn, and only the newer message keeps receiving edits", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    vi.useFakeTimers();

    try {
      await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "a".repeat(3990) });
      vi.advanceTimersByTime(1001);
      // Pushes the accumulated buffer past 4000 chars — must finalize message 1 and open message 2.
      await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "b".repeat(50) });
      vi.advanceTimersByTime(1001);
      // A further edit must land on message 2, never message 1 again.
      await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "c".repeat(10) });
    } finally {
      vi.useRealTimers();
    }

    expect(sentMessages).toHaveLength(2);
    const [firstMessageId, secondMessageId] = [100, 101];

    // Message 1 is finalized once (superseded by the boundary crossing) and never touched again.
    const editsToFirst = editedMessages.filter((e) => e.messageId === firstMessageId);
    expect(editsToFirst).toHaveLength(1);
    expect(editsToFirst[0].text).toContain("✅");

    // Message 2 receives the follow-up edit.
    const editsToSecond = editedMessages.filter((e) => e.messageId === secondMessageId);
    expect(editsToSecond).toHaveLength(1);
    expect(editsToSecond[0].text).toContain("c".repeat(10));
    expect(editsToSecond[0].text).toContain("🤖");

    // Both messages that were ever opened must have a reply-to mapping.
    expect(stateStore[`agent_msg_chat-1_${firstMessageId}`]).toEqual({ sessionId: "s1" });
    expect(stateStore[`agent_msg_chat-1_${secondMessageId}`]).toEqual({ sessionId: "s1" });
  });

  it("finalizes the open message and clears turn state on a terminal event, so the next event opens a brand-new message", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "working" });
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "finished" });

    expect(sentMessages).toHaveLength(1);
    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0].messageId).toBe(100);
    expect(editedMessages[0].text).toContain("finished");
    expect(editedMessages[0].text).toContain("✅");
    expect(stateStore["output_turn_chat-1_42_s1"]).toBeNull();

    // A later event for the same session starts a fresh message chain.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "new turn" });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].text).toContain("new turn");
    expect(sentMessages[1].text).toContain("🤖");
  });
});

describe("handleAcpOutput - resilience: edit-failure fallback, no-op skip, edit debounce (BLA-385)", () => {
  it("falls back to a new sendMessage when editMessage fails, and continues the turn from the new message", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    vi.useFakeTimers();

    try {
      await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "first" });
      vi.advanceTimersByTime(1001);

      vi.mocked(editMessage).mockResolvedValueOnce(false);
      await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "second" });
    } finally {
      vi.useRealTimers();
    }

    // editMessage was attempted (and failed) rather than silently skipped.
    expect(editMessage).toHaveBeenCalledTimes(1);

    // The failed edit falls back to a brand-new sendMessage carrying the full buffer.
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].text).toContain("first");
    expect(sentMessages[1].text).toContain("second");

    // Turn state now points at the new message, which has its own reply-to mapping.
    const newMessageId = 101;
    expect(stateStore["output_turn_chat-1_42_s1"]).toMatchObject({ messageId: newMessageId });
    expect(stateStore[`agent_msg_chat-1_${newMessageId}`]).toEqual({ sessionId: "s1" });

    // The turn continues on the new message — a later edit lands there, never on the old one.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1001);
      await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "wrapping up" });
    } finally {
      vi.useRealTimers();
    }
    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0].messageId).toBe(newMessageId);
  });

  it("skips the editMessage call for a duplicate/empty event that doesn't change the buffer", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();

    // A "text" event with no `text` field derives to an empty string; as the
    // very first event of a turn the buffer is also "" — nothing changed and
    // the turn isn't ending, so there's nothing to send or edit.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42 });
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42 });

    expect(sentMessages).toHaveLength(0);
    expect(editedMessages).toHaveLength(0);
  });

  it("coalesces rapid-fire events within the debounce window into a single edit, and still flushes a terminal event immediately", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "line 0" });
    // Rapid-fire: no time advances between these, so each lands inside the debounce window.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "line 1" });
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "line 2" });
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "line 3" });
    // Terminal event must flush immediately, without waiting out the debounce window.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "line 4" });

    expect(sentMessages).toHaveLength(1);
    // All 4 coalesced deltas plus the terminal event land in a single edit.
    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0].text).toContain("line 0");
    expect(editedMessages[0].text).toContain("line 1");
    expect(editedMessages[0].text).toContain("line 2");
    expect(editedMessages[0].text).toContain("line 3");
    expect(editedMessages[0].text).toContain("line 4");
    expect(editedMessages[0].text).toContain("✅");
  });
});

describe("handleAcpOutput - real ACP wire contract (regression: tool_call/tool_result/error events have no `text` field)", () => {
  it("does not throw and renders tool_call events without a text field", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();

    await expect(handleAcpOutput(ctx, "token", {
      sessionId: "s1", type: "tool_call", chatId: "chat-1", threadId: 42,
      toolName: "bash", toolInput: "ls -la",
    })).resolves.toBeUndefined();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("bash");
    expect(sentMessages[0].text).toContain("ls -la");
  });

  it("does not throw and renders tool_result events without a text field", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();

    await expect(handleAcpOutput(ctx, "token", {
      sessionId: "s1", type: "tool_result", chatId: "chat-1", threadId: 42,
      toolName: "bash", toolOutput: "file1\nfile2",
    })).resolves.toBeUndefined();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("bash");
    expect(sentMessages[0].text).toContain("file1");
  });

  it("does not throw and renders error events without a text field, and treats error as terminal", async () => {
    stateStore["sessions_chat-1_42"] = [
      activeSession({ sessionId: "s1", agentDisplayName: "Builder" }),
      activeSession({ sessionId: "s2", agentDisplayName: "Tester" }),
    ];
    const ctx = mockCtx();

    // s1 holds the floor without finishing.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "working..." });
    // s2 queues behind s1.
    await handleAcpOutput(ctx, "token", { sessionId: "s2", type: "text", chatId: "chat-1", threadId: 42, text: "waiting" });

    await expect(handleAcpOutput(ctx, "token", {
      sessionId: "s1", type: "error", chatId: "chat-1", threadId: 42, error: "agent crashed",
    })).resolves.toBeUndefined();

    // The error yields the floor before its own message is applied, so s2's
    // queued output flushes (as a new sendMessage) before s1's open message
    // is edited to its finalized, error-carrying content.
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].text).toContain("waiting");
    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0].text).toContain("agent crashed");
    expect(editedMessages[0].text).toContain("✅");
  });

  it("uses event.text verbatim for done events, and treats done as terminal", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", {
      sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "Agent exited with code 0",
    });

    expect(sentMessages[0].text).toContain("Agent exited with code 0");
    expect(sentMessages[0].text).toContain("✅"); // done emoji renders now that `done` is a real signal
  });
});

describe("handleAcpOutput - session bookkeeping", () => {
  it("updates lastActivityAt for the matching session", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession({ lastActivityAt: "2020-01-01T00:00:00Z" })];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "hi" });

    const sessions = stateStore["sessions_chat-1_42"] as Array<Record<string, unknown>>;
    expect(sessions[0].lastActivityAt).not.toBe("2020-01-01T00:00:00Z");
  });

  it("still sends output under the generic 'Agent' label when the session is unknown", async () => {
    const ctx = mockCtx();
    await handleAcpOutput(ctx, "token", { sessionId: "unknown-session", type: "done", chatId: "chat-1", threadId: 42, text: "hi" });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("Agent");
  });
});

describe("handleAcpOutput - multi-agent output sequencing (regression: interleaved agent output must not garble the transcript)", () => {
  it("queues a second agent's output while a first agent is still mid-stream, then flushes it once the first is done", async () => {
    stateStore["sessions_chat-1_42"] = [
      activeSession({ sessionId: "s1", agentDisplayName: "Builder" }),
      activeSession({ sessionId: "s2", agentDisplayName: "Tester" }),
    ];
    const ctx = mockCtx();

    // Builder starts speaking (not done yet) — becomes the current speaker.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "building..." });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("Builder");

    // Tester tries to speak while Builder still holds the floor — must be queued, not sent immediately.
    await handleAcpOutput(ctx, "token", { sessionId: "s2", type: "text", chatId: "chat-1", threadId: 42, text: "waiting to test" });
    expect(sentMessages).toHaveLength(1);

    // Builder finishes — this should flush Tester's queued output. Builder's
    // own "done" lands on its already-open message as an edit, not a new send.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "done", chatId: "chat-1", threadId: 42, text: "build complete" });

    expect(sentMessages).toHaveLength(2);
    expect(editedMessages).toHaveLength(1);

    // The queued Tester output is flushed as soon as Builder yields the floor,
    // before Builder's own "done" edit is applied.
    expect(sentMessages[1].text).toContain("Tester");
    expect(sentMessages[1].text).toContain("waiting to test");
    expect(editedMessages[0].messageId).toBe(100);
    expect(editedMessages[0].text).toContain("Builder");
    expect(editedMessages[0].text).toContain("build complete");
    expect(editedMessages[0].text).toContain("✅");
  });

  it("does not engage sequencing when only one agent is active in the thread", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession({ sessionId: "s1" })];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", { sessionId: "s1", type: "text", chatId: "chat-1", threadId: 42, text: "solo output" });

    expect(sentMessages).toHaveLength(1);
  });
});
