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

const { handleCommand } = await import("../src/commands.js");
const { resolveChoiceCallback } = await import("../src/workflow-choice.js");

function agent(id: string, name: string, status: string): Agent {
  return { id, name, status } as Agent;
}

const created: Array<Record<string, unknown>> = [];
const updated: Array<[string, Record<string, unknown>]> = [];

function makeCtx(agents: Agent[]): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { write: vi.fn(async () => undefined) },
    agents: { list: vi.fn(async () => agents) },
    companies: { get: vi.fn(async () => ({ issuePrefix: "BLA" })) },
    state: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
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

/** Let handleChoose reach askChoice and register its pending entry. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function pressButton(index: number): boolean {
  const keyboard = sent.at(-1)?.inlineKeyboard as Array<Array<{ callback_data: string }>>;
  return resolveChoiceCallback(keyboard.flat()[index]!.callback_data);
}

describe("/choose", () => {
  beforeEach(() => {
    sent.length = 0;
    created.length = 0;
    updated.length = 0;
  });

  it("offers only agents that can take work", async () => {
    const ctx = makeCtx([
      agent("a1", "Backend Engineer", "idle"),
      agent("a2", "Paused One", "paused"),
      agent("a3", "Broken One", "error"),
      agent("a4", "Head of Product", "running"),
    ]);

    const run = handleCommand(ctx, "tok", "chat-1", "choose", "Fix the dashboard", undefined, undefined, undefined, "company-1");
    await flush();

    const keyboard = sent.at(-1)?.inlineKeyboard as Array<Array<{ text: string }>>;
    const labels = keyboard.flat().map((b) => b.text);
    expect(labels).toHaveLength(2);
    expect(labels.join(" ")).toContain("Backend Engineer");
    expect(labels.join(" ")).toContain("Head of Product");
    // A paused or errored agent would accept the task and never start it.
    expect(labels.join(" ")).not.toContain("Paused One");
    expect(labels.join(" ")).not.toContain("Broken One");

    pressButton(0);
    await run;
  });

  it("creates the issue unassigned, then assigns — so the wake fires", async () => {
    const ctx = makeCtx([agent("a1", "Backend Engineer", "idle")]);

    const run = handleCommand(ctx, "tok", "chat-1", "choose", "Fix the dashboard", undefined, undefined, undefined, "company-1");
    await flush();
    pressButton(0);
    await run;

    // The assignee must NOT be set at creation time: issue_assigned only fires
    // on a null -> agent transition, so a create-with-assignee never wakes it.
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty("assigneeAgentId");
    expect(updated).toHaveLength(1);
    expect(updated[0]![1]).toMatchObject({ status: "todo", assigneeAgentId: "a1" });
    expect(sent.at(-1)?.text).toContain("Backend Engineer");
  });

  it("reports agent state instead of creating anything when no task is given", async () => {
    const ctx = makeCtx([agent("a1", "Backend Engineer", "idle")]);

    const run = handleCommand(ctx, "tok", "chat-1", "choose", "", undefined, undefined, undefined, "company-1");
    await flush();
    pressButton(0);
    await run;

    expect(created).toHaveLength(0);
    expect(sent.at(-1)?.text).toContain("Backend Engineer");
  });

  it("says so when nothing can take work, rather than showing an empty list", async () => {
    const ctx = makeCtx([agent("a2", "Paused One", "paused")]);

    await handleCommand(ctx, "tok", "chat-1", "choose", "Fix it", undefined, undefined, undefined, "company-1");

    expect(sent.at(-1)?.text).toContain("No agents are available");
    expect(created).toHaveLength(0);
  });
});
