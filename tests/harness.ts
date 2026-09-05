import { vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Shared host-contract fixture. 27 of 38 test files built their own
 * mockCtx()/makeCtx(), and 23 re-stubbed ../src/telegram-api.js — enough
 * copies that the fixtures drifted (duplicate mock keys, a state store keyed
 * only by `stateKey` while the real host also keys on `scopeKind`/`scopeId`/
 * `namespace`). This module is the one picture of that seam. It is additive:
 * existing test files keep their own fixtures until a change already touches
 * them.
 */

// --- Scoped state store -----------------------------------------------------

type ScopeKeyInput = {
  scopeKind: string;
  scopeId?: string;
  namespace?: string;
  stateKey: string;
};

/**
 * `ctx.state` is keyed by the full `{ scopeKind, scopeId, namespace,
 * stateKey }` tuple, not just `stateKey` (see PluginStateClient in
 * @paperclipai/plugin-sdk). Several existing fixtures simplify this to a bare
 * `stateStore[key.stateKey]` map, which silently conflates two scopes or two
 * namespaces that happen to share a stateKey string. This store keys on the
 * full tuple so a company-scoped write and an instance-scoped write to the
 * same stateKey never collide.
 */
export interface ScopedStateStore {
  get: (key: ScopeKeyInput) => Promise<unknown>;
  set: (key: ScopeKeyInput, value: unknown) => Promise<void>;
  delete: (key: ScopeKeyInput) => Promise<void>;
  /** Read the raw stored value for assertions, bypassing the mock's async get(). */
  peek: (key: ScopeKeyInput) => unknown;
  /** Seed a value directly, bypassing the mock's async set(). */
  seed: (key: ScopeKeyInput, value: unknown) => void;
  /** Clear every stored entry. */
  clear: () => void;
}

function scopeEntryId(key: ScopeKeyInput): string {
  return [key.scopeKind, key.scopeId ?? "", key.namespace ?? "default", key.stateKey].join("::");
}

export function createScopedStateStore(): ScopedStateStore {
  const entries = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: ScopeKeyInput) => entries.get(scopeEntryId(key)) ?? null),
    set: vi.fn(async (key: ScopeKeyInput, value: unknown) => {
      entries.set(scopeEntryId(key), value);
    }),
    delete: vi.fn(async (key: ScopeKeyInput) => {
      entries.delete(scopeEntryId(key));
    }),
    peek: (key: ScopeKeyInput) => entries.get(scopeEntryId(key)) ?? null,
    seed: (key: ScopeKeyInput, value: unknown) => {
      entries.set(scopeEntryId(key), value);
    },
    clear: () => entries.clear(),
  };
}

/**
 * Builders for the `stateKey` strings the plugin's source hand-rolls today
 * (`sessions_${chatId}_${threadId}`, `loop_${chatId}_${threadId}`, etc. in
 * src/acp-bridge.ts). Centralizing them here means a rename only breaks one
 * file instead of every suite that guessed the format.
 */
export const stateKeys = {
  sessions: (chatId: string, threadId: number | string) => `sessions_${chatId}_${threadId}`,
  loop: (chatId: string, threadId: number | string) => `loop_${chatId}_${threadId}`,
  handoff: (handoffId: string) => `handoff_${handoffId}`,
  chat: (chatId: string) => `chat_${chatId}`,
  agentMsg: (chatId: string, messageId: number | string) => `agent_msg_${chatId}_${messageId}`,
  commands: (companyId: string) => `commands_${companyId}`,
};

// --- Mock PluginContext -----------------------------------------------------

export type MockCtxOverrides = {
  [K in keyof PluginContext]?: Partial<PluginContext[K]>;
};

/**
 * Builds a `PluginContext` covering the fields this plugin's handlers
 * actually read (http, metrics, state, logger, config, companies, projects,
 * agents, issues) with the same default shapes the 27 hand-rolled fixtures
 * converged on. `overrides` is shallow-merged one level into each client, so
 * `{ agents: { invoke: vi.fn()... } }` replaces just `agents.invoke` and
 * keeps the default `agents.list`.
 *
 * Pass `state` (from `createScopedStateStore()`) to share one store across
 * a test's ctx instances, or omit it to get a private store per call.
 */
export function createMockCtx(overrides: MockCtxOverrides = {}, state: ScopedStateStore = createScopedStateStore()): PluginContext {
  const defaults = {
    http: {
      fetch: vi.fn().mockResolvedValue({
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("ok"),
      }),
    },
    metrics: { write: vi.fn() },
    state: { get: state.get, set: state.set, delete: state.delete },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { get: vi.fn().mockResolvedValue({ paperclipBaseUrl: "http://localhost:3100" }) },
    companies: {
      get: vi.fn().mockResolvedValue({ id: "co-1", name: "Test Co", issuePrefix: "PROJ" }),
      list: vi.fn().mockResolvedValue([{ id: "co-1", name: "Test Co", issuePrefix: "PROJ" }]),
    },
    projects: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    issues: {
      get: vi.fn().mockResolvedValue({ id: "i1", title: "Test", status: "open" }),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "created-issue-1" }),
      update: vi.fn().mockResolvedValue({ id: "created-issue-1" }),
    },
    events: { emit: vi.fn() },
  };

  const merged: Record<string, unknown> = { ...defaults };
  for (const [client, clientOverrides] of Object.entries(overrides) as Array<[string, Record<string, unknown>]>) {
    merged[client] = { ...(defaults as Record<string, unknown>)[client] as Record<string, unknown>, ...clientOverrides };
  }

  return merged as unknown as PluginContext;
}

// --- telegram-api.js mock ---------------------------------------------------

export type SentMessage = { chatId: string; text: string; options?: Record<string, unknown> };
export type EditedMessage = { chatId: string; messageId: number; text: string; options?: Record<string, unknown> };
export type AnsweredCallback = { callbackQueryId: string; text?: string };

export interface TelegramApiRecorder {
  sentMessages: SentMessage[];
  editedMessages: EditedMessage[];
  answeredCallbacks: AnsweredCallback[];
  reset(): void;
}

export function createTelegramApiRecorder(): TelegramApiRecorder {
  const recorder: TelegramApiRecorder = {
    sentMessages: [],
    editedMessages: [],
    answeredCallbacks: [],
    reset() {
      recorder.sentMessages.length = 0;
      recorder.editedMessages.length = 0;
      recorder.answeredCallbacks.length = 0;
    },
  };
  return recorder;
}

/**
 * Returns the factory to pass as the second argument to
 * `vi.mock("../src/telegram-api.js", ...)`. Keeps every real export (so
 * `escapeMarkdownV2`, `truncateAtWord`, etc. still behave) and replaces only
 * the network-shaped calls with recorders.
 *
 * `vi.mock(...)` calls are hoisted above every import in the file — including
 * the import of this module — so nothing reachable only through a normal
 * `import` is safe to reference inside the factory (existing per-file
 * fixtures dodge this by declaring `let sentMessages` and the whole mock
 * inline, in the same file, instead of importing either). `vi.hoisted(...)`
 * is the sanctioned escape hatch: it runs before `vi.mock`, so pull both this
 * function and the recorder through it, in the consuming test file:
 *
 *   const { telegram, telegramApiMockFactory } = await vi.hoisted(async () => {
 *     const harness = await import("./harness.js");
 *     return { telegram: harness.createTelegramApiRecorder(), telegramApiMockFactory: harness.telegramApiMockFactory };
 *   });
 *   vi.mock("../src/telegram-api.js", () => telegramApiMockFactory(telegram)());
 */
export function telegramApiMockFactory(recorder: TelegramApiRecorder) {
  return async () => {
    const actual = await vi.importActual<typeof import("../src/telegram-api.js")>("../src/telegram-api.js");
    let nextMessageId = 1;
    return {
      ...actual,
      sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
        recorder.sentMessages.push({ chatId, text, options });
        return nextMessageId++;
      }),
      editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => {
        recorder.editedMessages.push({ chatId, messageId, text, options });
        return true;
      }),
      answerCallbackQuery: vi.fn(async (_ctx: unknown, _token: string, callbackQueryId: string, text?: string) => {
        recorder.answeredCallbacks.push({ callbackQueryId, text });
      }),
      sendChatAction: vi.fn(async () => undefined),
    };
  };
}
