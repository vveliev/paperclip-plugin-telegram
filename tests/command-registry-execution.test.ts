import { describe, it, expect, vi, beforeEach } from "vitest";
import { tryCustomCommand, type CustomCommand } from "../src/command-registry.js";
import { createMockCtx, createScopedStateStore } from "./harness.js";

/**
 * Exercises tests/harness.ts end to end against `invoke_agent`,
 * `create_issue`, and `set_state` — the three custom-command step types that
 * no existing suite executes. command-registry.test.ts and
 * workflow-approval.test.ts cover import validation and the approval-gate
 * flow, but never drive `executeStep` for these three cases, so
 * `ctx.agents.invoke`, `ctx.issues.create`/`update`, and a company-scoped
 * `ctx.state.set` were previously unexercised.
 */

// vi.mock is hoisted above every import in this file, so the recorder and
// telegramApiMockFactory must come through vi.hoisted rather than a plain
// import — see telegramApiMockFactory's doc comment in harness.ts.
const { telegram, telegramApiMockFactory } = await vi.hoisted(async () => {
  const harness = await import("./harness.js");
  return { telegram: harness.createTelegramApiRecorder(), telegramApiMockFactory: harness.telegramApiMockFactory };
});
vi.mock("../src/telegram-api.js", () => telegramApiMockFactory(telegram)());

const COMPANY_ID = "co-exec-1";

function registryKey(companyId: string) {
  return { scopeKind: "company", scopeId: companyId, stateKey: `commands_${companyId}` };
}

function seedCommand(state: ReturnType<typeof createScopedStateStore>, cmd: CustomCommand) {
  state.seed(registryKey(COMPANY_ID), [cmd]);
}

beforeEach(() => {
  telegram.reset();
});

describe("invoke_agent step", () => {
  it("invokes the agent with an interpolated prompt and threads the runId into the next step", async () => {
    const state = createScopedStateStore();
    seedCommand(state, {
      name: "escalate",
      description: "Escalate to an agent",
      steps: [
        { id: "s1", type: "invoke_agent", agentId: "agent-42", prompt: "Handle {{arg0}}" },
        { id: "s2", type: "send_message", text: "Invoked run {{prev.result}}" },
      ],
      createdBy: "test",
      createdAt: "2026-01-01",
    });
    const ctx = createMockCtx({ agents: { invoke: vi.fn().mockResolvedValue({ runId: "run-777" }) } }, state);

    const handled = await tryCustomCommand(ctx, "token", "chat-1", "escalate", "ISSUE-1", undefined, COMPANY_ID);

    expect(handled).toBe(true);
    expect(ctx.agents.invoke).toHaveBeenCalledWith("agent-42", COMPANY_ID, {
      prompt: "Handle ISSUE-1",
      reason: "custom_command:s1",
    });
    expect(telegram.sentMessages.some((m) => m.text === "Invoked run run-777")).toBe(true);
  });
});

describe("create_issue step", () => {
  it("creates the issue and, when an assignee is set, follows up with a status update", async () => {
    const state = createScopedStateStore();
    seedCommand(state, {
      name: "file-bug",
      description: "File a bug",
      steps: [
        { id: "s1", type: "create_issue", title: "Bug: {{args}}", assigneeAgentId: "agent-9" },
      ],
      createdBy: "test",
      createdAt: "2026-01-01",
    });
    const ctx = createMockCtx({
      issues: {
        create: vi.fn().mockResolvedValue({ id: "issue-new-1" }),
        update: vi.fn().mockResolvedValue({ id: "issue-new-1" }),
      },
    }, state);

    await tryCustomCommand(ctx, "token", "chat-1", "file-bug", "login crash", undefined, COMPANY_ID);

    expect(ctx.issues.create).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      title: "Bug: login crash",
      description: undefined,
      projectId: undefined,
      assigneeAgentId: "agent-9",
    });
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-new-1", { status: "todo" }, COMPANY_ID);
  });

  it("skips the status update when no assignee is given", async () => {
    const state = createScopedStateStore();
    seedCommand(state, {
      name: "file-bug",
      description: "File a bug",
      steps: [{ id: "s1", type: "create_issue", title: "Unassigned bug" }],
      createdBy: "test",
      createdAt: "2026-01-01",
    });
    const ctx = createMockCtx({}, state);

    await tryCustomCommand(ctx, "token", "chat-1", "file-bug", "", undefined, COMPANY_ID);

    expect(ctx.issues.update).not.toHaveBeenCalled();
  });
});

describe("set_state step", () => {
  it("writes company-scoped state under the interpolated key, distinct from an instance-scoped key of the same name", async () => {
    const state = createScopedStateStore();
    seedCommand(state, {
      name: "remember",
      description: "Remember a value",
      steps: [{ id: "s1", type: "set_state", key: "note_{{arg0}}", value: "{{arg1}}" }],
      createdBy: "test",
      createdAt: "2026-01-01",
    });
    // Pre-seed an instance-scoped entry under the *same* stateKey the step
    // will write to, company-scoped. A store keyed only by `stateKey` (the
    // pattern several existing fixtures use) would let the step's write
    // clobber this entry; the harness's full-tuple key keeps them apart.
    state.seed({ scopeKind: "instance", stateKey: "note_42" }, "unrelated-instance-value");
    const ctx = createMockCtx({}, state);

    await tryCustomCommand(ctx, "token", "chat-1", "remember", "42 hello", undefined, COMPANY_ID);

    expect(state.peek({ scopeKind: "company", scopeId: COMPANY_ID, stateKey: "note_42" })).toBe("hello");
    expect(state.peek({ scopeKind: "instance", stateKey: "note_42" })).toBe("unrelated-instance-value");
  });
});
