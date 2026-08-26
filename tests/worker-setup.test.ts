import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { EscalationManager } from "../src/escalation.js";

/**
 * BLA-163. `setup()` is the one piece of worker.ts that was structurally
 * unreachable from a test: the polling loop, ~15 event-subscription
 * handlers, and job registration all live inside a closure that nothing
 * outside the module could call. `plugin` is now exported for exactly this
 * reason (see the comment above its declaration in worker.ts).
 *
 * Two real outages (BLA-218) came from this closure and both were silent —
 * a runtime lookup that skipped the only company, and two scheduled jobs
 * that no-oped while logging success. The tests here drive `setup()` through
 * a fake PluginContext and assert on the same kind of externally-observable
 * silence: was Telegram's HTTP API called or not, was a handler registered
 * or not, was a job wired to the runtime it needs or not.
 */

const checkWatchesMock = vi.fn(async () => {});
vi.mock("../src/watch-registry.js", async () => {
  const actual = await vi.importActual("../src/watch-registry.js");
  return { ...actual, checkWatches: checkWatchesMock };
});

const { plugin } = await import("../src/worker.js");

type FakeCompany = { id: string; name?: string; issuePrefix?: string };

const BASE_CONFIG: Record<string, unknown> = {
  telegramBotTokenRef: "bot-token-ref",
  defaultChatId: "1001",
  approvalsChatId: "",
  approvalsTopicId: "",
  errorsChatId: "",
  errorsTopicId: "",
  digestChatId: "",
  digestTopicId: "",
  paperclipBaseUrl: "",
  paperclipBoardApiTokenRef: "",
  paperclipPublicUrl: "",
  notifyOnIssueCreated: false,
  notifyOnIssueDone: false,
  notifyOnIssueAssigned: false,
  onlyNotifyIfAssignedTo: "",
  notifyOnApprovalCreated: false,
  onlyNotifyBoardApprovals: false,
  notifyOnAgentError: false,
  notifyOnAgentRunStarted: false,
  notifyOnAgentRunFinished: false,
  enableCommands: false,
  enableInbound: false,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
  digestMode: "off",
  dailyDigestTime: "09:00",
  bidailySecondTime: "",
  tridailyTimes: "",
  topicRouting: false,
  maxAgentsPerThread: 3,
  escalationChatId: "",
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "",
  briefAgentId: "",
  briefAgentChatIds: [],
  transcriptionApiKeyRef: "",
  maxSuggestionsPerHourPerCompany: 10,
  watchDeduplicationWindowMs: 86400000,
};

function stateKeyOf(input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }): string {
  return `${input.scopeKind}:${input.scopeId ?? ""}:${input.namespace ?? "default"}:${input.stateKey}`;
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

type FetchCall = { path: string; url: string; init: Record<string, unknown> };

/**
 * Every test that ends up with at least one polling runtime starts a real
 * `pollUpdates` loop that runs until `plugin.stopping` fires. Left alone it
 * spins forever calling `getUpdates` in a tight loop and leaks across tests.
 * Auto-stopping after the first `getUpdates` call makes every test safe by
 * default; the dedicated polling-loop tests below override this path
 * explicitly when they need more than one iteration.
 */
function makeFetchRouter(
  harness: { events: Record<string, Array<(event: unknown) => Promise<void> | void>> },
  overrides: Record<string, (url: string, init: Record<string, unknown>, calls: FetchCall[]) => unknown> = {},
) {
  const calls: FetchCall[] = [];
  let getUpdatesCalls = 0;
  const fetchMock = vi.fn(async (url: string, init: Record<string, unknown> = {}) => {
    const path = url.split("/bot")[1]?.split("?")[0]?.split("/").pop() ?? "";
    calls.push({ path, url, init });
    if (overrides[path]) return overrides[path](url, init, calls);
    if (path === "getUpdates") {
      getUpdatesCalls++;
      if (getUpdatesCalls > 5) throw new Error("runaway polling loop: getUpdates called more than 5 times");
      if (getUpdatesCalls === 1) {
        for (const fn of harness.events["plugin.stopping"] ?? []) await fn(undefined);
      }
      return jsonResponse({ ok: true, result: [] });
    }
    if (path === "sendMessage") return jsonResponse({ ok: true, result: { message_id: calls.length } });
    if (path === "setMyCommands") return jsonResponse({ ok: true, result: true });
    if (path === "answerCallbackQuery") return jsonResponse({ ok: true });
    if (path === "getChat") return jsonResponse({ ok: true, result: { is_forum: false } });
    throw new Error(`Unhandled fetch to ${url}`);
  });
  return { fetchMock, calls };
}

function makeHarness(options: {
  companies?: FakeCompany[];
  perCompanyConfig?: Record<string, Record<string, unknown>>;
  fetchOverrides?: Record<string, (url: string, init: Record<string, unknown>, calls: FetchCall[]) => unknown>;
  issuesGet?: (...args: unknown[]) => Promise<unknown>;
  issuesList?: (...args: unknown[]) => Promise<unknown>;
  issuesListComments?: (...args: unknown[]) => Promise<unknown>;
  agentsGet?: (...args: unknown[]) => Promise<unknown>;
  agentsList?: (...args: unknown[]) => Promise<unknown>;
} = {}) {
  const companies = options.companies ?? [];
  const events: Record<string, Array<(event: unknown) => Promise<void> | void>> = {};
  const jobs: Record<string, (job: unknown) => Promise<void>> = {};
  const actions: Record<string, (params: unknown) => Promise<unknown>> = {};
  const data: Record<string, (params: unknown) => Promise<unknown>> = {};
  const tools: Record<string, { def: unknown; handler: (params: unknown, runCtx: unknown) => Promise<unknown> }> = {};
  const stateStore = new Map<string, unknown>();

  const { fetchMock, calls } = makeFetchRouter({ events }, options.fetchOverrides);

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    companies: {
      list: vi.fn(async () => companies),
      get: vi.fn(async (id: string) => companies.find((c) => c.id === id) ?? null),
    },
    config: {
      get: vi.fn(async (companyId?: string) => {
        const specific = companyId ? options.perCompanyConfig?.[companyId] : undefined;
        return { ...(specific ?? BASE_CONFIG) };
      }),
    },
    secrets: {
      resolve: vi.fn(async (ref: unknown) => `resolved:${typeof ref === "string" ? ref : JSON.stringify(ref)}`),
    },
    state: {
      get: vi.fn(async (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        const key = stateKeyOf(input);
        return stateStore.has(key) ? stateStore.get(key) : null;
      }),
      set: vi.fn(async (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
        stateStore.set(stateKeyOf(input), value);
      }),
      delete: vi.fn(async (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        stateStore.delete(stateKeyOf(input));
      }),
    },
    http: { fetch: fetchMock },
    events: {
      on: vi.fn((name: string, fn: (event: unknown) => Promise<void> | void) => {
        (events[name] ??= []).push(fn);
      }),
    },
    jobs: {
      register: vi.fn((key: string, fn: (job: unknown) => Promise<void>) => {
        jobs[key] = fn;
      }),
    },
    actions: {
      register: vi.fn((key: string, fn: (params: unknown) => Promise<unknown>) => {
        actions[key] = fn;
      }),
    },
    data: {
      register: vi.fn((key: string, fn: (params: unknown) => Promise<unknown>) => {
        data[key] = fn;
      }),
    },
    tools: {
      register: vi.fn((name: string, def: unknown, fn: (params: unknown, runCtx: unknown) => Promise<unknown>) => {
        tools[name] = { def, handler: fn };
      }),
    },
    issues: {
      get: options.issuesGet ?? vi.fn(async () => null),
      list: options.issuesList ?? vi.fn(async () => []),
      listComments: options.issuesListComments ?? vi.fn(async () => []),
      createComment: vi.fn(async () => {}),
    },
    agents: {
      get: options.agentsGet ?? vi.fn(async () => null),
      list: options.agentsList ?? vi.fn(async () => []),
    },
    metrics: { write: vi.fn(async () => {}) },
    activity: { log: vi.fn(async () => {}) },
  } as unknown as PluginContext;

  return { ctx, events, jobs, actions, data, tools, stateStore, fetchMock, calls };
}

function sendMessageCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.path === "sendMessage");
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body));
}

function makeEvent(overrides: Partial<PluginEvent> & { payload?: Record<string, unknown> } = {}): PluginEvent {
  return {
    eventId: "evt-1",
    eventType: "issue.created",
    occurredAt: "2026-08-17T00:00:00.000Z",
    companyId: "co-1",
    entityId: "issue-1",
    entityType: "issue",
    payload: {},
    ...overrides,
  };
}

async function emit(
  harness: { events: Record<string, Array<(event: unknown) => Promise<void> | void>> },
  name: string,
  event: PluginEvent,
): Promise<void> {
  for (const fn of harness.events[name] ?? []) await fn(event);
}

const COMPANY: FakeCompany = { id: "co-1", name: "Acme", issuePrefix: "ACME" };

describe("setup() registration surface", () => {
  it("registers every job, tool, action, and data handler it declares", async () => {
    const harness = makeHarness({ companies: [COMPANY], perCompanyConfig: { "co-1": BASE_CONFIG } });

    await plugin.definition.setup(harness.ctx);

    // A handler missing from this list runs nowhere and fails nowhere — the
    // host simply never calls it. That silence is exactly what this pins.
    expect(Object.keys(harness.jobs).sort()).toEqual(
      ["check-escalation-timeouts", "check-watches", "telegram-daily-digest"].sort(),
    );
    expect(Object.keys(harness.tools).sort()).toEqual(
      ["discuss_with_agent", "escalate_to_human", "handoff_to_agent", "register_watch"].sort(),
    );
    expect(Object.keys(harness.actions).sort()).toEqual(["board-access.update", "set-chat"].sort());
    expect(Object.keys(harness.data).sort()).toEqual(["board-access.read", "chat-mapping"].sort());
  });
});

describe("setup() event subscriptions", () => {
  it("forwards issue.created to Telegram when notifyOnIssueCreated is on", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnIssueCreated: true } },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(harness, "issue.created", makeEvent({ payload: { identifier: "ACME-1", title: "New issue" } }));

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("does not forward issue.created when notifyOnIssueCreated is off", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnIssueCreated: false } },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(harness, "issue.created", makeEvent({ payload: { identifier: "ACME-1", title: "New issue" } }));

    expect(sendMessageCalls(harness.calls)).toHaveLength(0);
  });

  it("forwards issue.updated only once it reaches status done", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnIssueDone: true } },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(
      harness,
      "issue.updated",
      makeEvent({ payload: { identifier: "ACME-1", title: "T", status: "in_progress" } }),
    );
    expect(sendMessageCalls(harness.calls)).toHaveLength(0);

    await emit(
      harness,
      "issue.updated",
      makeEvent({ payload: { identifier: "ACME-1", title: "T", status: "done", comment: "shipped" } }),
    );
    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("dedupes a repeated issue.updated(done) event instead of sending it twice", async () => {
    // The dedupe Map is created once, at setup() time, closed over by the
    // handler. If a refactor moved it inside the handler body instead, every
    // call would see a fresh Map and this guard would silently stop working
    // — a duplicate host event would become a duplicate Telegram message.
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnIssueDone: true } },
    });
    await plugin.definition.setup(harness.ctx);

    const event = makeEvent({ payload: { identifier: "ACME-1", title: "T", status: "done", comment: "shipped" } });
    await emit(harness, "issue.updated", event);
    await emit(harness, "issue.updated", event);

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("enriches a done issue from the host when the event omits title and comment", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnIssueDone: true } },
      issuesGet: vi.fn(async () => ({ id: "issue-1", title: "Fetched title" })),
      issuesListComments: vi.fn(async () => [
        { id: "c1", body: "Fetched comment", createdAt: "2026-08-17T00:00:00.000Z" },
      ]),
    });
    await plugin.definition.setup(harness.ctx);

    await emit(harness, "issue.updated", makeEvent({ payload: { identifier: "ACME-1", status: "done" } }));

    const [call] = sendMessageCalls(harness.calls);
    const text = String(bodyOf(call).text);
    expect(text).toContain("Fetched title");
    expect(text).toContain("Fetched comment");
  });

  it("still sends the notification when best-effort enrichment throws", async () => {
    // "Best effort" only means anything if a lookup failure cannot also take
    // down the notification it was trying to improve.
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnIssueDone: true } },
      issuesGet: vi.fn(async () => {
        throw new Error("host unavailable");
      }),
    });
    await plugin.definition.setup(harness.ctx);

    await emit(harness, "issue.updated", makeEvent({ payload: { identifier: "ACME-1", status: "done" } }));

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("does not forward an assignment change that does not match onlyNotifyIfAssignedTo", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: {
        "co-1": { ...BASE_CONFIG, notifyOnIssueAssigned: true, onlyNotifyIfAssignedTo: "user-2" },
      },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(
      harness,
      "issue.updated",
      makeEvent({
        payload: {
          identifier: "ACME-1",
          title: "T",
          assigneeUserId: "user-1",
          assigneeName: "Alice",
          _previous: { assigneeUserId: null },
        },
      }),
    );

    expect(sendMessageCalls(harness.calls)).toHaveLength(0);
  });

  it("forwards an assignment change that matches onlyNotifyIfAssignedTo", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: {
        "co-1": { ...BASE_CONFIG, notifyOnIssueAssigned: true, onlyNotifyIfAssignedTo: "user-1" },
      },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(
      harness,
      "issue.updated",
      makeEvent({
        payload: {
          identifier: "ACME-1",
          title: "T",
          assigneeUserId: "user-1",
          assigneeName: "Alice",
          _previous: { assigneeUserId: null },
        },
      }),
    );

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("forwards approval.created when notifyOnApprovalCreated is on", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnApprovalCreated: true } },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(
      harness,
      "approval.created",
      makeEvent({
        eventType: "approval.created",
        entityId: "approval-1",
        entityType: "approval",
        payload: { type: "request_board_approval", approvalId: "approval-1" },
      }),
    );

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("forwards agent.run.failed when notifyOnAgentError is on", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnAgentError: true } },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(
      harness,
      "agent.run.failed",
      makeEvent({
        eventType: "agent.run.failed",
        entityId: "agent-1",
        entityType: "agent",
        payload: { agentId: "agent-1", error: "boom" },
      }),
    );

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("dedupes a repeated agent.run.failed event instead of paging twice", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnAgentError: true } },
    });
    await plugin.definition.setup(harness.ctx);

    const event = makeEvent({
      eventType: "agent.run.failed",
      entityId: "agent-1",
      entityType: "agent",
      payload: { agentId: "agent-1", error: "boom" },
    });
    await emit(harness, "agent.run.failed", event);
    await emit(harness, "agent.run.failed", event);

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("forwards agent.run.started when notifyOnAgentRunStarted is on", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnAgentRunStarted: true } },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(
      harness,
      "agent.run.started",
      makeEvent({
        eventType: "agent.run.started",
        entityId: "agent-1",
        entityType: "agent",
        payload: { agentId: "agent-1" },
      }),
    );

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("forwards agent.run.finished when notifyOnAgentRunFinished is on", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, notifyOnAgentRunFinished: true } },
    });
    await plugin.definition.setup(harness.ctx);

    await emit(
      harness,
      "agent.run.finished",
      makeEvent({
        eventType: "agent.run.finished",
        entityId: "agent-1",
        entityType: "agent",
        payload: { agentId: "agent-1" },
      }),
    );

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });
});

describe("setup() daily digest job", () => {
  const DIGEST_CONFIG = { ...BASE_CONFIG, digestMode: "daily", dailyDigestTime: "09:00" };

  it("a manual run sends the digest regardless of the current time", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": DIGEST_CONFIG },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["telegram-daily-digest"]({
      jobKey: "telegram-daily-digest",
      runId: "run-1",
      trigger: "manual",
      scheduledAt: "2026-08-17T03:00:00.000Z", // not the configured 09:00 slot
    });

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("a scheduled run sends the digest exactly at the configured slot", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": DIGEST_CONFIG },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["telegram-daily-digest"]({
      jobKey: "telegram-daily-digest",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T09:00:00.000Z",
    });

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("a scheduled run one minute off the configured slot sends nothing", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": DIGEST_CONFIG },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["telegram-daily-digest"]({
      jobKey: "telegram-daily-digest",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T09:01:00.000Z",
    });

    expect(sendMessageCalls(harness.calls)).toHaveLength(0);
  });

  it("does not resend a scheduled digest for a slot already marked sent", async () => {
    // This is the guard against firing twice: a digest that fires once and a
    // digest that fires twice both look like nothing happened from outside.
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": DIGEST_CONFIG },
    });
    harness.stateStore.set(
      stateKeyOf({ scopeKind: "company", scopeId: "co-1", stateKey: "digest_sent_2026-08-17_09:00" }),
      { sentAt: "2026-08-17T09:00:00.000Z", jobRunId: "prior-run" },
    );
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["telegram-daily-digest"]({
      jobKey: "telegram-daily-digest",
      runId: "run-2",
      trigger: "schedule",
      scheduledAt: "2026-08-17T09:00:00.000Z",
    });

    expect(sendMessageCalls(harness.calls)).toHaveLength(0);
  });

  it("skips a company with digest mode off without affecting a sibling company", async () => {
    const harness = makeHarness({
      companies: [{ id: "co-1" }, { id: "co-2" }],
      perCompanyConfig: {
        "co-1": { ...BASE_CONFIG, digestMode: "off" },
        "co-2": DIGEST_CONFIG,
      },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["telegram-daily-digest"]({
      jobKey: "telegram-daily-digest",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T09:00:00.000Z",
    });

    expect(sendMessageCalls(harness.calls)).toHaveLength(1);
  });

  it("sends an error digest instead of silently doing nothing when building it fails", async () => {
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": DIGEST_CONFIG },
      agentsList: vi.fn(async () => {
        throw new Error("agents host call failed");
      }),
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["telegram-daily-digest"]({
      jobKey: "telegram-daily-digest",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T09:00:00.000Z",
    });

    const sent = sendMessageCalls(harness.calls);
    expect(sent).toHaveLength(1);
    expect(String(bodyOf(sent[0]).text)).toContain("Could not generate digest");
    expect(harness.ctx.logger.error).toHaveBeenCalled();
  });
});

describe("setup() escalation timeout and watch jobs", () => {
  it("wires the startup company's runtime through to check-escalation-timeouts", async () => {
    const checkTimeouts = vi.spyOn(EscalationManager.prototype, "checkTimeouts").mockResolvedValue(undefined);
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, enableInbound: true } },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["check-escalation-timeouts"]({
      jobKey: "check-escalation-timeouts",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T00:00:00.000Z",
    });

    expect(checkTimeouts).toHaveBeenCalledWith(expect.anything(), expect.any(String), "co-1");
    checkTimeouts.mockRestore();
  });

  it("skips a company whose config exposes no inbound route for check-escalation-timeouts", async () => {
    const checkTimeouts = vi.spyOn(EscalationManager.prototype, "checkTimeouts").mockResolvedValue(undefined);
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, enableInbound: false, escalationChatId: "" } },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["check-escalation-timeouts"]({
      jobKey: "check-escalation-timeouts",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T00:00:00.000Z",
    });

    expect(checkTimeouts).not.toHaveBeenCalled();
    checkTimeouts.mockRestore();
  });

  it("wires the startup company's runtime through to check-watches", async () => {
    checkWatchesMock.mockClear();
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, enableInbound: true, maxSuggestionsPerHourPerCompany: 10 } },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["check-watches"]({
      jobKey: "check-watches",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T00:00:00.000Z",
    });

    expect(checkWatchesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ maxSuggestionsPerHourPerCompany: 10 }),
      "co-1",
    );
  });

  it("does not run check-watches for a company that set suggestions to zero", async () => {
    checkWatchesMock.mockClear();
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, enableInbound: true, maxSuggestionsPerHourPerCompany: 0 } },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.jobs["check-watches"]({
      jobKey: "check-watches",
      runId: "run-1",
      trigger: "schedule",
      scheduledAt: "2026-08-17T00:00:00.000Z",
    });

    expect(checkWatchesMock).not.toHaveBeenCalled();
  });
});

describe("setup() bot command registration", () => {
  it("registers commands with Telegram once per shared token, not once per company", async () => {
    const harness = makeHarness({
      companies: [{ id: "co-1" }, { id: "co-2" }],
      perCompanyConfig: {
        "co-1": { ...BASE_CONFIG, enableCommands: true, defaultChatId: "1001" },
        "co-2": { ...BASE_CONFIG, enableCommands: true, defaultChatId: "2002" },
      },
    });

    await plugin.definition.setup(harness.ctx);
    // setMyCommands is fire-and-forget (.then/.catch, not awaited by setup()).
    await vi.waitFor(() => {
      expect(harness.calls.some((c) => c.path === "setMyCommands")).toBe(true);
    });

    expect(harness.calls.filter((c) => c.path === "setMyCommands")).toHaveLength(1);
  });
});

describe("setup() long polling", () => {
  it("starts no polling loop and warns when no runtime resolves", async () => {
    const harness = makeHarness({ companies: [], perCompanyConfig: {} });

    await plugin.definition.setup(harness.ctx);

    expect(harness.calls.some((c) => c.path === "getUpdates")).toBe(false);
    expect(harness.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No company-scoped Telegram bot token is resolvable"),
    );
  });

  it("dispatches a matched update, persists the offset, and stops cleanly on plugin.stopping", async () => {
    const UPDATE = {
      update_id: 501,
      callback_query: {
        id: "cb-1",
        from: { id: 42, username: "alice" },
        message: { message_id: 7, chat: { id: 1001 } },
        data: "no_such_action",
      },
    };
    let getUpdatesCalls = 0;
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: { "co-1": { ...BASE_CONFIG, enableInbound: true, defaultChatId: "1001" } },
      fetchOverrides: {
        getUpdates: async () => {
          getUpdatesCalls++;
          if (getUpdatesCalls === 1) return jsonResponse({ ok: true, result: [UPDATE] });
          for (const fn of harness.events["plugin.stopping"] ?? []) await fn(undefined);
          return jsonResponse({ ok: true, result: [] });
        },
      },
    });

    await plugin.definition.setup(harness.ctx);

    await vi.waitFor(() => {
      expect(getUpdatesCalls).toBeGreaterThanOrEqual(2);
    });
    // Give the second (stopping) iteration's microtasks a turn to settle.
    await vi.waitFor(() => {
      expect(harness.calls.some((c) => c.path === "answerCallbackQuery")).toBe(true);
    });

    expect(getUpdatesCalls).toBe(2); // exactly one extra poll after stopping, not a runaway loop
    expect(harness.stateStore.get(stateKeyOf({ scopeKind: "instance", stateKey: "telegram-last-update-id" }))).toBe(
      501,
    );
  });

  it("logs and skips dispatch when no runtime matches the update's chat", async () => {
    const UPDATE = {
      update_id: 900,
      message: { message_id: 1, chat: { id: 999999, type: "private" }, text: "hello" },
    };
    let getUpdatesCalls = 0;
    const harness = makeHarness({
      companies: [{ id: "co-1" }, { id: "co-2" }],
      perCompanyConfig: {
        "co-1": { ...BASE_CONFIG, enableInbound: true, telegramBotTokenRef: "shared-ref", defaultChatId: "1001" },
        "co-2": { ...BASE_CONFIG, enableInbound: true, telegramBotTokenRef: "shared-ref", defaultChatId: "2002" },
      },
      fetchOverrides: {
        getUpdates: async () => {
          getUpdatesCalls++;
          if (getUpdatesCalls === 1) return jsonResponse({ ok: true, result: [UPDATE] });
          for (const fn of harness.events["plugin.stopping"] ?? []) await fn(undefined);
          return jsonResponse({ ok: true, result: [] });
        },
      },
    });

    await plugin.definition.setup(harness.ctx);

    await vi.waitFor(() => {
      expect(getUpdatesCalls).toBeGreaterThanOrEqual(2);
    });

    expect(harness.ctx.logger.warn).toHaveBeenCalledWith(
      "No company-scoped Telegram runtime matched update",
      expect.objectContaining({ updateId: 900 }),
    );
    expect(harness.calls.some((c) => c.path === "sendMessage")).toBe(false);
  });

  it("resolves a parked wait_approval Approve callback delivered through the real polling loop (BLA-606)", async () => {
    // Unlike tests/workflow-approval.test.ts, which calls
    // resolveWorkflowApprovalCallback directly, this drives the button press
    // through the exact path production uses: getUpdates -> pollUpdates's
    // selectTelegramRuntimeForUpdate -> handleUpdate -> handleCallbackQuery.
    const APPROVAL_ID = "1700000000000_s1";
    const PARKED = {
      commandName: "testapproval",
      args: [],
      results: [],
      nextStepIndex: 1,
      chatId: "1001",
      messageThreadId: undefined,
      companyId: "co-1",
      createdAt: 1700000000000,
    };
    const COMMAND = {
      name: "testapproval",
      description: "Test wait_approval gate",
      steps: [
        { id: "s1", type: "wait_approval", prompt: "Approve this test?" },
        { id: "s2", type: "send_message", text: "Gate passed - resumed after approval" },
      ],
      createdBy: "tester",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const UPDATE = {
      update_id: 777,
      callback_query: {
        id: "cb-approve-1",
        from: { id: 42, username: "vagif" },
        message: { message_id: 55, chat: { id: 1001 }, text: "Approve this test?" },
        data: `cmd_approve_${APPROVAL_ID}`,
      },
    };

    let getUpdatesCalls = 0;
    const harness = makeHarness({
      companies: [COMPANY],
      perCompanyConfig: {
        "co-1": { ...BASE_CONFIG, enableInbound: true, enableCommands: true, defaultChatId: "1001" },
      },
      fetchOverrides: {
        getUpdates: async () => {
          getUpdatesCalls++;
          if (getUpdatesCalls === 1) return jsonResponse({ ok: true, result: [UPDATE] });
          for (const fn of harness.events["plugin.stopping"] ?? []) await fn(undefined);
          return jsonResponse({ ok: true, result: [] });
        },
        editMessageText: async () => jsonResponse({ ok: true }),
      },
    });

    // Seed the parked workflow and command registry as if
    // `/commands run testapproval` had already sent the Approve/Reject buttons.
    harness.stateStore.set(
      stateKeyOf({ scopeKind: "instance", stateKey: `cmd_approval_${APPROVAL_ID}` }),
      PARKED,
    );
    harness.stateStore.set(
      stateKeyOf({ scopeKind: "company", scopeId: "co-1", stateKey: "commands_co-1" }),
      [COMMAND],
    );

    await plugin.definition.setup(harness.ctx);

    await vi.waitFor(() => {
      expect(getUpdatesCalls).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(harness.calls.some((c) => c.path === "answerCallbackQuery")).toBe(true);
    });

    expect(harness.calls.some((c) => c.path === "editMessageText")).toBe(true);
    expect(
      sendMessageCalls(harness.calls).some(
        (c) => bodyOf(c).text === "Gate passed - resumed after approval",
      ),
    ).toBe(true);
  });

  it("backs off after a fetch error and retries instead of exiting the loop", async () => {
    vi.useFakeTimers();
    try {
      let getUpdatesCalls = 0;
      const harness = makeHarness({
        companies: [COMPANY],
        perCompanyConfig: { "co-1": { ...BASE_CONFIG, enableInbound: true } },
        fetchOverrides: {
          getUpdates: async () => {
            getUpdatesCalls++;
            if (getUpdatesCalls === 1) throw new Error("network blip");
            for (const fn of harness.events["plugin.stopping"] ?? []) await fn(undefined);
            return jsonResponse({ ok: true, result: [] });
          },
        },
      });

      await plugin.definition.setup(harness.ctx);
      await vi.advanceTimersByTimeAsync(0);

      expect(getUpdatesCalls).toBe(1);
      expect(harness.ctx.logger.error).toHaveBeenCalledWith(
        "Telegram polling error",
        expect.objectContaining({ error: expect.stringContaining("network blip") }),
      );

      // The loop must not have exited after the error — it retries after a backoff.
      await vi.advanceTimersByTimeAsync(5000);
      expect(getUpdatesCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
