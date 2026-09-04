import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { handleCommandsCommand, tryCustomCommand, BUILTIN_COMMANDS } from "../src/command-registry.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const SRC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src");

/**
 * GIF-149: `tryCustomCommand` runs before `handleCommand`'s dispatcher, so a
 * name that is dispatchable but missing from BUILTIN_COMMANDS both (a) passes
 * the "cannot override a built-in" check on import and (b) permanently
 * shadows the real handler. This extracts the actual `case "x":` labels of
 * `handleCommand`'s top-level switch in commands.ts — the ground truth for
 * "dispatchable" — so the two can't silently drift apart again, the same
 * structural-scan approach parse-mode-convention.test.ts uses for sendMessage
 * call sites.
 */
function dispatchableCommandNames(): string[] {
  const src = readFileSync(path.join(SRC_DIR, "commands.ts"), "utf8");
  const switchStart = src.indexOf("switch (command) {");
  if (switchStart === -1) throw new Error("Could not find handleCommand's switch (command) block");
  const switchEnd = src.indexOf("\n  }", switchStart);
  if (switchEnd === -1) throw new Error("Could not find the end of handleCommand's switch block");
  const block = src.slice(switchStart, switchEnd);
  const names = [...block.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error("Extracted zero case labels — the regex or markers drifted");
  // "commands" is dispatched in worker.ts, ahead of tryCustomCommand, rather
  // than through this switch — but it is just as dispatchable and must be
  // just as protected.
  return [...names, "commands"];
}

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
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

describe("BUILTIN_COMMANDS drift guard", () => {
  it("covers every name handleCommand's switch actually dispatches", () => {
    // If this fails, a command was added to (or renamed in) handleCommand's
    // switch without a matching addition to BUILTIN_COMMANDS. Import-time
    // protection and the shadowing check above are only as complete as this
    // set — see GIF-149.
    const dispatchable = dispatchableCommandNames();
    const missing = dispatchable.filter((name) => !BUILTIN_COMMANDS.has(name));
    expect(missing).toEqual([]);
  });

  it("does not protect names that are no longer dispatchable", () => {
    // The inverse drift: a name left in BUILTIN_COMMANDS after its handler
    // was removed just blocks that name from ever being reused as a custom
    // command for no reason.
    const dispatchable = new Set(dispatchableCommandNames());
    const stale = [...BUILTIN_COMMANDS].filter((name) => !dispatchable.has(name));
    expect(stale).toEqual([]);
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

  it("rejects well-formed JSON that doesn't match the command definition shape", async () => {
    const ctx = mockCtx();
    // Parses fine, but is not a command definition: no 'name', no 'steps'.
    // Distinct from "Invalid JSON" — the JSON itself is valid.
    await handleCommandsCommand(ctx, "token", "123", `import ${JSON.stringify({ hello: 1 })}`, undefined, "co-1");
    expect(sentMessages[0].text).not.toContain("Invalid JSON");
    expect(sentMessages[0].text).toContain("'name'");
  });

  it("rejects a definition whose 'steps' field is not an array", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({ name: "bad", description: "bad", steps: "not-an-array" });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("'steps'");
  });

  it("rejects a send_message step missing 'text'", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "bad",
      description: "bad",
      steps: [{ id: "s1", type: "send_message" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("'text'");

    // Rejected at import time, not stored — nothing for executeWorkflow to
    // half-run later.
    const stored = stateStore["commands_co-1"] as Array<{ name: string }> | undefined;
    expect(stored).toBeUndefined();
  });

  it("rejects a fetch_issue step missing 'issueId'", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "bad",
      description: "bad",
      steps: [{ id: "s1", type: "fetch_issue" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("'issueId'");
  });

  it("rejects an http_request step with an invalid method", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "bad",
      description: "bad",
      steps: [{ id: "s1", type: "http_request", url: "https://example.com", method: "PATCH" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("'method'");
  });

  it("rejects an http_request step whose headers are not string values", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "bad",
      description: "bad",
      steps: [{ id: "s1", type: "http_request", url: "https://example.com", method: "GET", headers: { "X-Test": 1 } }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("'headers'");
  });

  it("accepts a fully-specified http_request step", async () => {
    const ctx = mockCtx();
    const cmd = JSON.stringify({
      name: "webhook",
      description: "Call a webhook",
      steps: [{ id: "s1", type: "http_request", url: "https://example.com", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    });
    await handleCommandsCommand(ctx, "token", "123", `import ${cmd}`, undefined, "co-1");
    expect(sentMessages[0].text).toContain("imported");
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
