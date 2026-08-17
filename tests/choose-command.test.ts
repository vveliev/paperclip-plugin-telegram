import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";

const sent: Array<{ text: string; inlineKeyboard?: unknown }> = [];

vi.mock("../src/telegram-api.js", () => ({
  sendMessage: vi.fn(async (_c: unknown, _t: string, _chat: string, text: string, opts?: { inlineKeyboard?: unknown }) => {
    sent.push({ text, inlineKeyboard: opts?.inlineKeyboard });
    return { ok: true };
  }),
  sendChatAction: vi.fn(async () => ({ ok: true })),
  escapeMarkdownV2: (s: string) => s,
}));

const { handleCommand, completeAgentPick } = await import("../src/commands.js");

function agent(id: string, name: string, status: string): Agent {
  return { id, name, status } as Agent;
}

const created: Array<Record<string, unknown>> = [];
const updated: Array<[string, Record<string, unknown>]> = [];
const stateStore = new Map<string, unknown>();

function key(scope: { scopeId?: string; stateKey: string }): string {
  return `${scope.scopeId ?? ""}:${scope.stateKey}`;
}

function makeCtx(agents: Agent[]): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { write: vi.fn(async () => undefined) },
    agents: { list: vi.fn(async () => agents) },
    companies: { get: vi.fn(async () => ({ issuePrefix: "BLA" })) },
    state: {
      get: vi.fn(async (scope: { scopeId?: string; stateKey: string }) => stateStore.get(key(scope)) ?? null),
      set: vi.fn(async (scope: { scopeId?: string; stateKey: string }, value: unknown) => {
        stateStore.set(key(scope), value);
      }),
    },
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        return { id: "issue-1", identifier: "BLA-1" };
      }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        updated.push([id, patch]);
        return { id, identifier: "BLA-1" };
      }),
    },
  } as unknown as PluginContext;
}

function buttonData(index: number): string {
  const keyboard = sent.at(-1)?.inlineKeyboard as Array<Array<{ callback_data: string }>>;
  return keyboard.flat()[index]!.callback_data;
}

beforeEach(() => {
  sent.length = 0;
  created.length = 0;
  updated.length = 0;
  stateStore.clear();
});

describe("/choose — send phase", () => {
  it("returns immediately after sending buttons, without waiting for a press", async () => {
    // This is the whole point: updates are processed sequentially, so a handler
    // that awaited the press would block the loop that delivers it — the answer
    // could never arrive and the bot would appear frozen.
    const ctx = makeCtx([agent("a1", "Backend Engineer", "idle")]);

    const settled = await Promise.race([
      handleCommand(ctx, "tok", "chat-1", "choose", "Fix it", undefined, undefined, undefined, "company-1").then(() => "returned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);

    expect(settled).toBe("returned");
    expect(sent.at(-1)?.inlineKeyboard).toBeDefined();
  });

  it("offers only agents that can take work", async () => {
    const ctx = makeCtx([
      agent("a1", "Backend Engineer", "idle"),
      agent("a2", "Paused One", "paused"),
      agent("a3", "Broken One", "error"),
    ]);

    await handleCommand(ctx, "tok", "chat-1", "choose", "Fix it", undefined, undefined, undefined, "company-1");

    const labels = (sent.at(-1)?.inlineKeyboard as Array<Array<{ text: string }>>).flat().map((b) => b.text);
    expect(labels).toEqual(["⚪ Backend Engineer"]);
  });

  it("says so when nothing can take work", async () => {
    const ctx = makeCtx([agent("a2", "Paused One", "paused")]);
    await handleCommand(ctx, "tok", "chat-1", "choose", "Fix it", undefined, undefined, undefined, "company-1");
    expect(sent.at(-1)?.text).toContain("No agents are available");
  });
});

describe("/choose — callback phase", () => {
  it("creates the issue unassigned, then assigns — so the wake fires", async () => {
    const ctx = makeCtx([agent("a1", "Backend Engineer", "idle")]);
    await handleCommand(ctx, "tok", "chat-1", "choose", "Fix the dashboard", undefined, undefined, undefined, "company-1");

    const result = await completeAgentPick(ctx, "tok", buttonData(0), "company-1");

    expect(result).toEqual({ ok: true, message: "Backend Engineer" });
    // issue_assigned only fires on a null -> agent transition.
    expect(created[0]).not.toHaveProperty("assigneeAgentId");
    expect(updated[0]![1]).toMatchObject({ status: "todo", assigneeAgentId: "a1" });
  });

  it("ignores a second tap of the same button", async () => {
    const ctx = makeCtx([agent("a1", "Backend Engineer", "idle")]);
    await handleCommand(ctx, "tok", "chat-1", "choose", "Fix it", undefined, undefined, undefined, "company-1");
    const data = buttonData(0);

    await completeAgentPick(ctx, "tok", data, "company-1");
    const second = await completeAgentPick(ctx, "tok", data, "company-1");

    // Telegram can redeliver a callback; without clear-on-read this would file
    // the task twice.
    expect(second.ok).toBe(false);
    expect(created).toHaveLength(1);
  });

  it("reports agent state instead of creating anything when no task was given", async () => {
    const ctx = makeCtx([agent("a1", "Backend Engineer", "idle")]);
    await handleCommand(ctx, "tok", "chat-1", "choose", "", undefined, undefined, undefined, "company-1");

    const result = await completeAgentPick(ctx, "tok", buttonData(0), "company-1");

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(0);
    expect(sent.at(-1)?.text).toContain("Backend Engineer");
  });

  it("reports expiry for an unknown pick key", async () => {
    const ctx = makeCtx([agent("a1", "Backend Engineer", "idle")]);
    const result = await completeAgentPick(ctx, "tok", "chs_deadbeef_0", "company-1");
    expect(result).toEqual({ ok: false, message: "That pick has expired" });
  });
});
