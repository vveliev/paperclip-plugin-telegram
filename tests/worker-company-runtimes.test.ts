import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

import { listCompaniesForStartup, resolveCompanyRuntimes } from "../src/worker.js";

type TelegramConfigLike = { enableCommands?: boolean; enableInbound?: boolean };

let stateStore: Record<string, unknown> = {};
let configByCompany: Record<string, Record<string, unknown>> = {};

function mockCtx(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    companies: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    config: {
      get: vi.fn(async (companyId: string) => configByCompany[companyId] ?? {}),
    },
    secrets: {
      resolve: vi.fn().mockResolvedValue("bot-token-123"),
    },
    ...overrides,
  } as unknown as PluginContext;
}

beforeEach(() => {
  stateStore = {};
  configByCompany = {};
});

describe("listCompaniesForStartup (regression: companies.list returning [] must not silently disable polling)", () => {
  it("returns the companies.list result when it is non-empty", async () => {
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }, { id: "co-2" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);
    expect(result).toEqual([{ id: "co-1" }, { id: "co-2" }]);
  });

  it("falls back to the board-access companyId when companies.list SUCCEEDS but returns []", async () => {
    stateStore["telegram.board-access.v1"] = { companyId: "co-fallback" };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);

    // This is the exact bug this function exists to prevent: an empty array
    // returned WITHOUT a thrown error must still fall back, or polling never starts.
    expect(result).toEqual([{ id: "co-fallback" }]);
  });

  it("falls back to the board-access companyId when companies.list throws", async () => {
    stateStore["telegram.board-access.v1"] = { companyId: "co-fallback" };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockRejectedValue(new Error("no invocation scope")), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);
    expect(result).toEqual([{ id: "co-fallback" }]);
  });

  it("returns [] and logs a warning when there is no fallback company id either", async () => {
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);
    expect(result).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no fallback company id is known"),
      expect.anything(),
    );
  });
});

describe("resolveCompanyRuntimes (config merge + company-runtime resolution)", () => {
  const startupConfig = {
    telegramBotTokenRef: "",
    defaultChatId: "",
    paperclipBaseUrl: "http://startup-base",
  } as unknown as Parameters<typeof resolveCompanyRuntimes>[1];

  it("skips a company whose scoped config throws instead of aborting the whole resolution", async () => {
    stateStore["telegram.board-access.v1"] = { companyId: "co-1" };
    configByCompany = {
      "co-1": undefined as unknown as Record<string, unknown>,
      "co-2": { telegramBotTokenRef: "ref-2", defaultChatId: "chat-2" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }, { id: "co-2" }]), get: vi.fn() } as unknown as PluginContext["companies"],
      config: {
        get: vi.fn(async (companyId: string) => {
          if (companyId === "co-1") throw new Error("scope unavailable");
          return configByCompany[companyId] ?? {};
        }),
      } as unknown as PluginContext["config"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].companyId).toBe("co-2");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("config unavailable"),
      expect.objectContaining({ companyId: "co-1" }),
    );
  });

  it("skips companies with no telegramBotTokenRef key at all in scoped config", async () => {
    configByCompany = { "co-1": { someOtherKey: "x" } };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);
    expect(runtimes).toEqual([]);
  });

  it("merges scoped config over startup config so company-specific values win", async () => {
    configByCompany = {
      "co-1": { telegramBotTokenRef: "ref-1", defaultChatId: "company-chat" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].config.defaultChatId).toBe("company-chat");
    // paperclipBaseUrl was not overridden by the company, so the startup value survives the merge
    expect(runtimes[0].baseUrl).toBe("http://startup-base");
  });

  it("excludes a company when the predicate rejects its effective config", async () => {
    configByCompany = {
      "co-1": { telegramBotTokenRef: "ref-1", defaultChatId: "company-chat", enableCommands: false, enableInbound: false },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(
      ctx,
      startupConfig,
      (config) => Boolean(config.enableCommands || config.enableInbound),
    );
    expect(runtimes).toEqual([]);
  });

  it("skips a company when the bot token secret fails to resolve", async () => {
    configByCompany = {
      "co-1": { telegramBotTokenRef: "ref-1", defaultChatId: "company-chat" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
      secrets: { resolve: vi.fn().mockRejectedValue(new Error("secret gone")) } as unknown as PluginContext["secrets"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);
    expect(runtimes).toEqual([]);
  });

  it("uses a pre-fetched companies list instead of re-deriving it, when one is passed in", async () => {
    // setup() resolves listCompaniesForStartup once (to seed loadStartupConfig's
    // fallback) and should pass that same list through here rather than
    // triggering a second companies.list()/board-access lookup for one startup.
    configByCompany = {
      "co-1": { telegramBotTokenRef: "ref-1", defaultChatId: "company-chat" },
    };
    const companiesList = vi.fn().mockResolvedValue([{ id: "co-should-not-be-used" }]);
    const ctx = mockCtx({
      companies: { list: companiesList, get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true, [{ id: "co-1" }]);

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].companyId).toBe("co-1");
    expect(companiesList).not.toHaveBeenCalled();
  });

  it("excludes a company whose scoped routing values are identical to startup's (no real per-company override)", async () => {
    // hasCompanyTelegramRoute requires at least one routing key to differ from
    // the startup value. A company that echoes back the same blank/startup
    // values has no real Telegram route configured and must be skipped.
    configByCompany = {
      "co-1": { telegramBotTokenRef: "", defaultChatId: "" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);
    expect(runtimes).toEqual([]);
  });
});

describe("resolveCompanyRuntimes (BLA-175: startup config scoped to the same company)", () => {
  const companyConfig = {
    telegramBotTokenRef: { type: "secret_ref", secretId: "s1" },
    defaultChatId: "-1001234",
    enableCommands: true,
  };
  const wantsCommands = (c: TelegramConfigLike) => Boolean(c.enableCommands);

  it("builds a runtime when startupConfig IS that company's own config", async () => {
    // The outage. setup() resolves the company first and loads config scoped to
    // it, so startupConfig and the scoped config are identical. The
    // "does this company differ from the instance?" guard then finds nothing
    // different, skips the only company, and long polling never starts — while
    // startup still logs "Telegram bot plugin started".
    configByCompany["BLA"] = { ...companyConfig };

    const runtimes = await resolveCompanyRuntimes(
      mockCtx(),
      { ...companyConfig } as never,
      wantsCommands,
      [{ id: "BLA" }],
      "BLA",
    );

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].companyId).toBe("BLA");
    expect(runtimes[0].token).toBe("bot-token-123");
  });

  it("still builds a runtime when the startup config load failed and left defaults", async () => {
    // The path that accidentally kept polling alive before the fix. It must
    // keep working, or the fix trades one silent outage for another.
    configByCompany["BLA"] = { ...companyConfig };

    const runtimes = await resolveCompanyRuntimes(
      mockCtx(), {} as never, wantsCommands, [{ id: "BLA" }], "BLA",
    );

    expect(runtimes).toHaveLength(1);
  });

  it("does not spawn a duplicate runtime for a company that only inherits the instance config", async () => {
    // Why the diff guard exists: without it every company would produce a
    // runtime for the same bot and each inbound update would be handled twice.
    configByCompany["BLA"] = { ...companyConfig };
    configByCompany["OTHER"] = { ...companyConfig };

    const runtimes = await resolveCompanyRuntimes(
      mockCtx(), { ...companyConfig } as never, wantsCommands,
      [{ id: "BLA" }, { id: "OTHER" }], "BLA",
    );

    expect(runtimes.map((r) => r.companyId)).toEqual(["BLA"]);
  });

  it("builds runtimes for other companies that DO define their own route", async () => {
    configByCompany["BLA"] = { ...companyConfig };
    configByCompany["OTHER"] = { ...companyConfig, defaultChatId: "-1009999" };

    const runtimes = await resolveCompanyRuntimes(
      mockCtx(), { ...companyConfig } as never, wantsCommands,
      [{ id: "BLA" }, { id: "OTHER" }], "BLA",
    );

    expect(runtimes.map((r) => r.companyId).sort()).toEqual(["BLA", "OTHER"]);
  });

  it("keeps honouring the predicate for the startup company", async () => {
    // The exemption is about the config diff only; a company with commands and
    // inbound both disabled must still not be polled.
    configByCompany["BLA"] = { ...companyConfig, enableCommands: false };

    const runtimes = await resolveCompanyRuntimes(
      mockCtx(), { ...companyConfig, enableCommands: false } as never,
      wantsCommands, [{ id: "BLA" }], "BLA",
    );

    expect(runtimes).toHaveLength(0);
  });
});

describe("resolveCompanyRuntimes from scheduled jobs (BLA-175 follow-up)", () => {
  const companyConfig = {
    telegramBotTokenRef: { type: "secret_ref", secretId: "s1" },
    defaultChatId: "-1001234",
    enableInbound: true,
    escalationChatId: "-1005678",
  };

  it("resolves a runtime the way a job calls it — no prefetched companies", async () => {
    // check-escalation-timeouts and check-watches call this with no company
    // list, relying on the board-access fallback. They pass the same
    // company-scoped `config` setup() loaded, so without the startup company id
    // they hit the identical diff-guard skip: zero runtimes, the for-loop
    // iterates nothing, and the job logs "completed successfully" having done
    // nothing at all. Observed live via the skip-reason warning.
    stateStore["telegram.board-access.v1"] = { companyId: "BLA" };
    configByCompany["BLA"] = { ...companyConfig };

    const runtimes = await resolveCompanyRuntimes(
      mockCtx(),
      { ...companyConfig } as never,
      ((c: TelegramConfigLike & { escalationChatId?: string }) =>
        Boolean(c.enableInbound || c.escalationChatId)),
      undefined,
      "BLA",
    );

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].companyId).toBe("BLA");
  });

  it("returns nothing when the startup company id is withheld, proving the argument is load-bearing", async () => {
    stateStore["telegram.board-access.v1"] = { companyId: "BLA" };
    configByCompany["BLA"] = { ...companyConfig };

    const runtimes = await resolveCompanyRuntimes(
      mockCtx(),
      { ...companyConfig } as never,
      ((c: TelegramConfigLike & { escalationChatId?: string }) =>
        Boolean(c.enableInbound || c.escalationChatId)),
      undefined,
      null,
    );

    expect(runtimes).toHaveLength(0);
  });
});

describe("every resolveCompanyRuntimes call site passes the startup company", () => {
  it("has no call in worker.ts that omits it", async () => {
    // A structural check rather than a behavioural one, because the failure is
    // a CALLER forgetting an optional argument — there were three call sites
    // and fixing only the first left two jobs silently doing nothing. A fourth
    // call site added later would fail the same way, and no unit test of
    // resolveCompanyRuntimes itself can see that.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");

    const calls = [...src.matchAll(/resolveCompanyRuntimes\(([\s\S]*?)\n\s*\);/g)]
      .map((m) => m[1])
      // the declaration itself is not a call
      .filter((body) => !body.includes("ctx: PluginContext"));

    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const body of calls) {
      expect(body).toContain("startupConfigCompanyId");
    }
  });
});

describe("resolveCompanyRuntimes diagnostics (BLA-177)", () => {
  const wantsCommands = (c: TelegramConfigLike) => Boolean(c.enableCommands);

  /** The warn payload emitted when nothing could be polled. */
  async function skipReasons(config: Record<string, unknown>, secretResolves = true) {
    configByCompany["BLA"] = config;
    const ctx = mockCtx();
    if (!secretResolves) {
      (ctx.secrets.resolve as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    }
    const runtimes = await resolveCompanyRuntimes(
      ctx, {} as never, wantsCommands, [{ id: "BLA" }], null,
    );
    expect(runtimes).toHaveLength(0);
    const call = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => String(c[0]).includes("No Telegram runtime was built"));
    return call?.[1]?.skipped?.[0]?.reason ?? "";
  }

  it("says when the company config was never saved", async () => {
    expect(await skipReasons({ defaultChatId: "-100" })).toMatch(/never saved|no telegramBotTokenRef/i);
  });

  it("says when both inbound switches are off", async () => {
    const reason = await skipReasons({
      telegramBotTokenRef: { type: "secret_ref" }, defaultChatId: "-100", enableCommands: false,
    });
    expect(reason).toMatch(/both off/i);
  });

  it("says when the secret has no binding", async () => {
    const reason = await skipReasons({
      telegramBotTokenRef: { type: "secret_ref" }, defaultChatId: "-100", enableCommands: true,
    }, false);
    expect(reason).toMatch(/binding/i);
  });

  it("stays quiet when a runtime was built", async () => {
    configByCompany["BLA"] = {
      telegramBotTokenRef: { type: "secret_ref" }, defaultChatId: "-100", enableCommands: true,
    };
    const ctx = mockCtx();
    await resolveCompanyRuntimes(ctx, {} as never, wantsCommands, [{ id: "BLA" }], null);

    const noisy = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]).includes("No Telegram runtime was built"));
    expect(noisy).toHaveLength(0);
  });
});
