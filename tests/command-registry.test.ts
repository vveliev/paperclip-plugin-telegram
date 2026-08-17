import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCommandsCommand, tryCustomCommand } from "../src/command-registry.js";
import { resolveChoiceCallback } from "../src/workflow-choice.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
    sendChatAction: vi.fn(),
  };
});

function mockCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ id: "created-issue-1" }),
        text: () => Promise.resolve("ok"),
      }),
    },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { get: vi.fn().mockResolvedValue({ paperclipBaseUrl: "http://localhost:3100" }) },
    issues: { get: vi.fn().mockResolvedValue({ id: "i1", title: "Test", status: "open" }) },
    agents: { invoke: vi.fn().mockResolvedValue({ runId: "run-1" }) },
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
});

describe("handleCommandsCommand - subcommands", () => {
  it("shows help when no subcommand given", async () => {
    const ctx = mockCtx();
    await handleCommandsCommand(ctx, "token", "123", "", undefined, "co-1");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Custom Commands");
  });

  it("lists empty registry", async () => {
    const ctx = mockCtx();
    await handleCommandsCommand(ctx, "token", "123", "list", undefined, "co-1");
    expect(sentMessages[0].text).toContain("No custom commands");
  });

  it("imports a valid command", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "deploy",
      description: "Deploy to prod",
      steps: [{ id: "s1", type: "send_message", text: "Deploying..." }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("deploy");
    expect(sentMessages[0].text).toContain("imported");

    // Verify it's stored
    const stored = stateStore["commands_co-1"] as Array<{ name: string }>;
    expect(stored).toBeDefined();
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("deploy");
  });

  it("rejects import of invalid JSON", async () => {
    const ctx = mockCtx();
    await handleCommandsCommand(ctx, "token", "123", "import {invalid", undefined, "co-1");
    expect(sentMessages[0].text).toContain("Invalid JSON");
  });

  it("rejects import without name field", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({ steps: [{ id: "s1", type: "send_message", text: "hi" }] });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("must have");
  });

  it("deletes a command", async () => {
    stateStore["commands_co-1"] = [{
      name: "deploy",
      description: "Deploy",
      steps: [],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    await handleCommandsCommand(ctx, "token", "123", "delete deploy", undefined, "co-1");
    expect(sentMessages[0].text).toContain("deleted");

    const stored = stateStore["commands_co-1"] as Array<{ name: string }>;
    expect(stored.length).toBe(0);
  });

  it("reports not found when deleting nonexistent command", async () => {
    const ctx = mockCtx();
    await handleCommandsCommand(ctx, "token", "123", "delete nonexistent", undefined, "co-1");
    expect(sentMessages[0].text).toContain("not found");
  });
});

describe("Namespace protection - built-in commands cannot be overridden", () => {
  it("rejects import of /status as custom command", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "status",
      description: "Override status",
      steps: [{ id: "s1", type: "send_message", text: "hi" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("Cannot override built-in");
  });

  it("rejects import of /help as custom command", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "help",
      description: "Override help",
      steps: [{ id: "s1", type: "send_message", text: "hi" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("Cannot override built-in");
  });

  it("rejects import of /acp as custom command", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "acp",
      description: "Override acp",
      steps: [{ id: "s1", type: "send_message", text: "hi" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("Cannot override built-in");
  });
});

describe("tryCustomCommand - command lookup", () => {
  it("returns false for built-in commands", async () => {
    const ctx = mockCtx();
    const result = await tryCustomCommand(ctx, "token", "123", "status", "", undefined, "co-1");
    expect(result).toBe(false);
  });

  it("returns false when command not in registry", async () => {
    const ctx = mockCtx();
    const result = await tryCustomCommand(ctx, "token", "123", "unknown", "", undefined, "co-1");
    expect(result).toBe(false);
  });

  it("returns true and executes when command found in registry", async () => {
    stateStore["commands_co-1"] = [{
      name: "greet",
      description: "Greet user",
      steps: [{ id: "s1", type: "send_message", text: "Hello {{args}}" }],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    const result = await tryCustomCommand(ctx, "token", "123", "greet", "world", undefined, "co-1");
    expect(result).toBe(true);
    expect(sentMessages.some(m => m.text === "Hello world")).toBe(true);
  });
});

describe("Workflow step template interpolation", () => {
  it("interpolates {{arg0}} and {{arg1}} parameters", async () => {
    stateStore["commands_co-1"] = [{
      name: "deploy",
      description: "Deploy",
      steps: [{ id: "s1", type: "send_message", text: "Deploy {{arg0}} to {{arg1}}" }],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "token", "123", "deploy", "v1.2 prod", undefined, "co-1");
    expect(sentMessages.some(m => m.text === "Deploy v1.2 to prod")).toBe(true);
  });

  it("interpolates {{args}} as full args string", async () => {
    stateStore["commands_co-1"] = [{
      name: "echo",
      description: "Echo",
      steps: [{ id: "s1", type: "send_message", text: "You said: {{args}}" }],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "token", "123", "echo", "hello world", undefined, "co-1");
    expect(sentMessages.some(m => m.text === "You said: hello world")).toBe(true);
  });

  it("interpolates {{prev.result}} from previous step", async () => {
    stateStore["commands_co-1"] = [{
      name: "chain",
      description: "Chain",
      steps: [
        { id: "s1", type: "send_message", text: "step one" },
        { id: "s2", type: "send_message", text: "prev was: {{prev.result}}" },
      ],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "token", "123", "chain", "", undefined, "co-1");
    expect(sentMessages.some(m => m.text === "prev was: sent")).toBe(true);
  });

  it("interpolates {{step_id.result}} from specific step", async () => {
    stateStore["commands_co-1"] = [{
      name: "multi",
      description: "Multi step",
      steps: [
        { id: "first", type: "send_message", text: "one" },
        { id: "second", type: "send_message", text: "two" },
        { id: "third", type: "send_message", text: "first said: {{first.result}}" },
      ],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "token", "123", "multi", "", undefined, "co-1");
    expect(sentMessages.some(m => m.text === "first said: sent")).toBe(true);
  });
});

describe("wait_approval step", () => {
  /**
   * askChoice awaits sendMessage before registering its pending entry, and
   * that call is nested a few `await`s deep here (tryCustomCommand ->
   * executeWorkflow -> executeStep -> askChoice), so drain more microtask
   * ticks than a direct askChoice call would need.
   */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  function approvalCallbackData(): string {
    const msg = sentMessages.find(m => m.options?.inlineKeyboard);
    const keyboard = msg?.options?.inlineKeyboard as Array<Array<{ callback_data: string }>>;
    return keyboard.flat()[0]!.callback_data;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes the workflow when Approve is pressed, instead of parking forever", async () => {
    stateStore["commands_co-1"] = [{
      name: "release",
      description: "Release",
      steps: [
        { id: "s1", type: "wait_approval", prompt: "Ship it?" },
        { id: "s2", type: "send_message", text: "Decision: {{prev.result}}" },
      ],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    const run = tryCustomCommand(ctx, "token", "123", "release", "", undefined, "co-1");
    await flush();

    // The old cmd_approve_*/cmd_reject_* buttons had no handler; the fix
    // routes approval through the same wfc_* registry `choice` uses.
    const data = approvalCallbackData();
    expect(data).not.toMatch(/^cmd_approve_/);
    expect(resolveChoiceCallback(data)).toBe(true);

    await run;
    expect(sentMessages.some(m => m.text === "Decision: approved")).toBe(true);
  });

  it("resolves to rejected when Reject is pressed", async () => {
    stateStore["commands_co-1"] = [{
      name: "release",
      description: "Release",
      steps: [
        { id: "s1", type: "wait_approval", prompt: "Ship it?" },
        { id: "s2", type: "send_message", text: "Decision: {{prev.result}}" },
      ],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    const run = tryCustomCommand(ctx, "token", "123", "release", "", undefined, "co-1");
    await flush();

    const keyboard = sentMessages.find(m => m.options?.inlineKeyboard)?.options?.inlineKeyboard as Array<Array<{ callback_data: string }>>;
    const rejectData = keyboard.flat()[1]!.callback_data;
    expect(resolveChoiceCallback(rejectData)).toBe(true);

    await run;
    expect(sentMessages.some(m => m.text === "Decision: rejected")).toBe(true);
  });

  it("times out and stops waiting when nobody responds", async () => {
    stateStore["commands_co-1"] = [{
      name: "release",
      description: "Release",
      steps: [{ id: "s1", type: "wait_approval", prompt: "Ship it?", timeoutMs: 1000 }],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    const run = tryCustomCommand(ctx, "token", "123", "release", "", undefined, "co-1");
    await flush();

    vi.advanceTimersByTime(1001);
    await run;

    expect(sentMessages.some(m => m.text.includes("No response in time"))).toBe(true);
  });
});

describe("Command import validation", () => {
  it("rejects steps missing type field", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "bad",
      description: "bad",
      steps: [{ id: "s1" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("must have");
  });

  it("rejects steps with invalid type", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "bad",
      description: "bad",
      steps: [{ id: "s1", type: "invalid_type" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("Invalid step type");
  });

  it("updates existing command on re-import", async () => {
    stateStore["commands_co-1"] = [{
      name: "deploy",
      description: "Old deploy",
      steps: [{ id: "s1", type: "send_message", text: "old" }],
      createdBy: "test",
      createdAt: "2026-01-01",
    }];
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "deploy",
      description: "New deploy",
      steps: [{ id: "s1", type: "send_message", text: "new" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("updated");

    const stored = stateStore["commands_co-1"] as Array<{ description: string }>;
    expect(stored.length).toBe(1);
    expect(stored[0].description).toBe("New deploy");
  });
});
