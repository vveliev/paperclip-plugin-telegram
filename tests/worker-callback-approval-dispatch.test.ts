import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
let answeredCallbacks: string[] = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
  return {
    ...actual,
    sendMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
    sendChatAction: vi.fn(),
    editMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, messageId: number, text: string) => {
      editedMessages.push({ chatId, messageId, text });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (_c: unknown, _t: string, _id: string, text?: string) => {
      answeredCallbacks.push(text ?? "");
    }),
  };
});

// worker.ts's callback_query branch is the code path under test — it must NOT
// be mocked out, unlike tests/worker-handle-update.test.ts which stubs
// tryCustomCommand and never exercises a real wait_approval park/resume.
import { handleUpdate } from "../src/worker.js";

const CHAT_ID = 111;
const COMPANY_ID = "co-1";

const COMMAND = {
  name: "testapproval",
  description: "Test wait_approval gate",
  steps: [
    { id: "s1", type: "wait_approval", prompt: "Approve this test?" },
    { id: "s2", type: "send_message", text: "Gate passed - resumed after approval" },
  ],
};

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { get: vi.fn().mockResolvedValue({}) },
    companies: { get: vi.fn().mockResolvedValue(null) },
    issues: { get: vi.fn(), update: vi.fn() },
    agents: { invoke: vi.fn() },
    secrets: { resolve: vi.fn().mockResolvedValue("secret") },
  } as unknown as PluginContext;
}

/** The approval id embedded in the Approve button the wait_approval step sent. */
function approvalIdFromButtons(): string {
  const withButtons = sentMessages.find((m) => m.options?.inlineKeyboard);
  const kb = withButtons!.options!.inlineKeyboard as Array<Array<{ callback_data: string }>>;
  return kb[0][0].callback_data.replace("cmd_approve_", "");
}

function approveCallbackUpdate(approvalId: string) {
  return {
    update_id: 1000,
    callback_query: {
      id: "cbq-1",
      from: { id: 42, username: "vagif" },
      message: { message_id: 55, chat: { id: CHAT_ID }, text: "Approve this test?" },
      data: `cmd_approve_${approvalId}`,
    },
  } as Parameters<typeof handleUpdate>[3];
}

const config = { enableCommands: true, enableInbound: true } as Parameters<typeof handleUpdate>[2];
const baseUrl = "http://localhost:3100";

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  answeredCallbacks = [];
  stateStore = { [`commands_${COMPANY_ID}`]: [COMMAND] };
});

describe("BLA-606: wait_approval callback delivered through handleUpdate (not called directly)", () => {
  it("resolves the Approve button press when the callback_query arrives through the real update-dispatch path", async () => {
    const ctx = mockCtx();

    // Park the workflow at its wait_approval gate, exactly as /commands run would.
    const { tryCustomCommand } = await import("../src/command-registry.js");
    await tryCustomCommand(ctx, "tok", String(CHAT_ID), "testapproval", "", undefined, COMPANY_ID);
    expect(sentMessages.map((m) => m.text)).toContain("Approve this test?");
    const approvalId = approvalIdFromButtons();

    // Deliver the button press the way the live bot actually does: as a
    // callback_query update through handleUpdate, not a direct call to
    // resolveWorkflowApprovalCallback.
    await handleUpdate(ctx, "tok", config, approveCallbackUpdate(approvalId), baseUrl, undefined, undefined, COMPANY_ID);

    expect(answeredCallbacks).toContain("Approved");
    expect(editedMessages.some((m) => m.text.includes("Approved by vagif"))).toBe(true);
    expect(sentMessages.map((m) => m.text)).toContain("Gate passed - resumed after approval");
  });
});
