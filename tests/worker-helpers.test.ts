import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const isForumMock = vi.fn(async () => false);
vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return { ...actual, isForum: isForumMock };
});

const {
  makeUpdateDedupe,
  normalizeAgentErrorMessage,
  resolveChat,
  parseTopicId,
  validateConfiguredTopicIds,
  resolveDigestThreadId,
  resolveDigestMode,
  parseDigestTime,
  digestTimesForConfig,
  resolveDigestSlot,
} = await import("../src/worker.js");

/**
 * BLA-163. worker.ts sat at 33% because its decision logic was module-private:
 * which updates are duplicates, when a digest fires, whether a topic id is
 * usable. None of it could be reached from a test, so none of it was checked.
 *
 * These are the branches where being wrong is silent — a digest that never
 * fires and a digest that fires twice both look like "nothing happened" from
 * the outside.
 */

type Cfg = Record<string, unknown>;

beforeEach(() => {
  isForumMock.mockReset();
  isForumMock.mockResolvedValue(false);
});

describe("makeUpdateDedupe", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("admits an update the first time it is seen", () => {
    const dedupe = makeUpdateDedupe();
    expect(dedupe("update-1")).toBe(true);
  });

  it("rejects the same update inside the window", () => {
    const dedupe = makeUpdateDedupe(5_000);
    dedupe("update-1");
    vi.advanceTimersByTime(4_999);
    expect(dedupe("update-1")).toBe(false);
  });

  it("admits it again once the window has passed", () => {
    // Telegram redelivers updates that were never acknowledged, so suppressing
    // forever would drop a legitimate retry rather than a duplicate.
    const dedupe = makeUpdateDedupe(5_000);
    dedupe("update-1");
    vi.advanceTimersByTime(5_001);
    expect(dedupe("update-1")).toBe(true);
  });

  it("keeps distinct updates independent", () => {
    const dedupe = makeUpdateDedupe(5_000);
    expect(dedupe("a")).toBe(true);
    expect(dedupe("b")).toBe(true);
  });

  it("evicts only entries older than the window when over capacity", () => {
    // The eviction sweep must not drop live entries: dropping one re-admits a
    // duplicate, which is the bug this cache exists to prevent.
    const dedupe = makeUpdateDedupe(5_000, 3);
    dedupe("old-1");
    dedupe("old-2");
    vi.advanceTimersByTime(6_000);
    dedupe("fresh-1");
    dedupe("fresh-2");
    dedupe("fresh-3");

    expect(dedupe("fresh-1")).toBe(false);
    expect(dedupe("old-1")).toBe(true);
  });
});

describe("normalizeAgentErrorMessage", () => {
  it("collapses whitespace so a stack trace stays one line", () => {
    expect(normalizeAgentErrorMessage("boom\n\n  at foo\tbar")).toBe("boom at foo bar");
  });

  it("caps length so one error cannot exceed Telegram's message limit", () => {
    expect(normalizeAgentErrorMessage("x".repeat(900))).toHaveLength(500);
  });

  it("describes null and undefined rather than printing them", () => {
    expect(normalizeAgentErrorMessage(null)).toBe("Unknown error");
    expect(normalizeAgentErrorMessage(undefined)).toBe("Unknown error");
  });
});

describe("parseTopicId", () => {
  it("accepts a numeric string", () => {
    expect(parseTopicId("42")).toBe(42);
  });

  it("rejects anything non-numeric rather than coercing it", () => {
    // Number("12abc") is NaN but Number("") is 0 — a coercing parse would turn
    // an empty topic id into topic 0 and post to the wrong place.
    for (const bad of ["", "  ", "abc", "12abc", "1.5", "-3", "0x10"]) {
      expect(parseTopicId(bad)).toBeUndefined();
    }
  });

  it("treats a missing value as unset", () => {
    expect(parseTopicId(undefined)).toBeUndefined();
  });
});

describe("validateConfiguredTopicIds", () => {
  it("passes when the topic ids are numeric strings", () => {
    expect(validateConfiguredTopicIds({ approvalsTopicId: "10", errorsTopicId: "20" })).toEqual([]);
  });

  it("treats unset and empty as 'not configured', not as invalid", () => {
    const cfg: Cfg = { approvalsTopicId: "", errorsTopicId: null, digestTopicId: undefined };
    expect(validateConfiguredTopicIds(cfg)).toEqual([]);
  });

  it("names the offending key so the user knows which field to fix", () => {
    const errors = validateConfiguredTopicIds({ errorsTopicId: "general" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("errorsTopicId");
  });

  it("reports every bad key, not just the first", () => {
    const errors = validateConfiguredTopicIds({ approvalsTopicId: "a", errorsTopicId: "b", digestTopicId: "c" });
    expect(errors).toHaveLength(3);
  });

  it("rejects a non-string value", () => {
    expect(validateConfiguredTopicIds({ approvalsTopicId: 42 })).toHaveLength(1);
  });
});

describe("parseDigestTime", () => {
  it("reads bare hours and HH:MM", () => {
    expect(parseDigestTime("7")).toEqual({ hour: 7, minute: 0 });
    expect(parseDigestTime("07:30")).toEqual({ hour: 7, minute: 30 });
    expect(parseDigestTime(" 23:59 ")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects out-of-range times instead of wrapping them", () => {
    // 24:00 wrapping to 00:00 would silently fire the digest a day early.
    for (const bad of ["24:00", "23:60", "-1", "99"]) {
      expect(parseDigestTime(bad)).toBeNull();
    }
  });

  it("rejects unparseable input", () => {
    for (const bad of [undefined, "", "  ", "noon", "7:5", "7:005"]) {
      expect(parseDigestTime(bad as string | undefined)).toBeNull();
    }
  });
});

describe("resolveDigestMode", () => {
  it("uses the configured mode", () => {
    expect(resolveDigestMode({ digestMode: "bidaily" } as never)).toBe("bidaily");
  });

  it("honours the legacy dailyDigestEnabled flag when mode is off", () => {
    // Older configs only had the boolean. Ignoring it would silently turn the
    // digest off for everyone who upgraded without re-saving their config.
    expect(resolveDigestMode({ digestMode: "off", dailyDigestEnabled: true } as never)).toBe("daily");
  });

  it("does not let the legacy flag override an explicit mode", () => {
    expect(resolveDigestMode({ digestMode: "tridaily", dailyDigestEnabled: true } as never)).toBe("tridaily");
  });

  it("defaults to off when nothing is configured", () => {
    expect(resolveDigestMode({} as never)).toBe("off");
  });
});

describe("digestTimesForConfig", () => {
  it("returns nothing when the digest is off", () => {
    expect(digestTimesForConfig({ digestMode: "off" } as never)).toEqual([]);
  });

  it("returns the single daily time", () => {
    expect(digestTimesForConfig({ digestMode: "daily", dailyDigestTime: "09:00" } as never))
      .toEqual([{ hour: 9, minute: 0 }]);
  });

  it("returns both bidaily times", () => {
    expect(digestTimesForConfig({ digestMode: "bidaily", dailyDigestTime: "09:00", bidailySecondTime: "17:30" } as never))
      .toEqual([{ hour: 9, minute: 0 }, { hour: 17, minute: 30 }]);
  });

  it("drops an unparseable time rather than scheduling a NaN slot", () => {
    expect(digestTimesForConfig({ digestMode: "bidaily", dailyDigestTime: "09:00", bidailySecondTime: "nope" } as never))
      .toEqual([{ hour: 9, minute: 0 }]);
  });

  it("falls back to the documented tridaily default when unset", () => {
    expect(digestTimesForConfig({ digestMode: "tridaily" } as never))
      .toEqual([{ hour: 7, minute: 0 }, { hour: 13, minute: 0 }, { hour: 19, minute: 0 }]);
  });

  it("parses a custom tridaily list", () => {
    expect(digestTimesForConfig({ digestMode: "tridaily", tridailyTimes: "06:15,12:00,18:45" } as never))
      .toEqual([{ hour: 6, minute: 15 }, { hour: 12, minute: 0 }, { hour: 18, minute: 45 }]);
  });
});

describe("resolveDigestSlot", () => {
  const config = { digestMode: "daily", dailyDigestTime: "09:00" } as never;

  it("matches on the configured minute, in UTC", () => {
    expect(resolveDigestSlot(config, new Date("2026-08-17T09:00:00Z")))
      .toEqual({ dateKey: "2026-08-17", timeKey: "09:00" });
  });

  it("does not match a minute either side", () => {
    // The slot key is what stops a digest being sent twice; matching a range
    // would produce two different keys inside one intended send.
    expect(resolveDigestSlot(config, new Date("2026-08-17T08:59:00Z"))).toBeNull();
    expect(resolveDigestSlot(config, new Date("2026-08-17T09:01:00Z"))).toBeNull();
  });

  it("does not match local time when it differs from UTC", () => {
    expect(resolveDigestSlot(config, new Date("2026-08-17T09:00:00+02:00"))).toBeNull();
  });

  it("returns null when the digest is off", () => {
    expect(resolveDigestSlot({ digestMode: "off" } as never, new Date("2026-08-17T09:00:00Z"))).toBeNull();
  });

  it("zero-pads the time key so the same slot always keys identically", () => {
    const slot = resolveDigestSlot({ digestMode: "daily", dailyDigestTime: "7:05" } as never, new Date("2026-08-17T07:05:00Z"));
    expect(slot?.timeKey).toBe("07:05");
  });
});

describe("resolveDigestThreadId", () => {
  function ctx(): PluginContext {
    return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;
  }

  it("prefers an explicitly configured topic and does not probe the chat", async () => {
    expect(await resolveDigestThreadId(ctx(), "tok", "chat-1", "77")).toBe(77);
    expect(isForumMock).not.toHaveBeenCalled();
  });

  it("falls back to the General topic in a forum chat", async () => {
    isForumMock.mockResolvedValue(true);
    expect(await resolveDigestThreadId(ctx(), "tok", "chat-1", undefined)).toBe(1);
  });

  it("uses no thread in a plain chat", async () => {
    isForumMock.mockResolvedValue(false);
    expect(await resolveDigestThreadId(ctx(), "tok", "chat-1", undefined)).toBeUndefined();
  });

  it("ignores an unparseable configured topic rather than posting to topic NaN", async () => {
    isForumMock.mockResolvedValue(false);
    expect(await resolveDigestThreadId(ctx(), "tok", "chat-1", "general")).toBeUndefined();
  });
});

describe("resolveChat", () => {
  function ctx(stored: unknown): PluginContext {
    return {
      state: { get: vi.fn(async () => stored) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
  }

  it("prefers the company's stored chat over the configured default", async () => {
    expect(await resolveChat(ctx("chat-override"), "co-1", "chat-default")).toBe("chat-override");
  });

  it("uses the configured default when the company has no override", async () => {
    expect(await resolveChat(ctx(null), "co-1", "chat-default")).toBe("chat-default");
  });

  it("returns something falsy when there is no chat to send to", async () => {
    // All three callers branch on `if (!chatId)`, so falsy is the contract that
    // matters: no chat configured means skip rather than send somewhere wrong.
    //
    // Asserted as falsy rather than null on purpose. The signature says
    // `string | null`, but `??` only replaces null/undefined, so an empty
    // fallback comes back as "". Harmless for every caller today, and worth
    // knowing about before someone writes `=== null` and it silently stops
    // skipping.
    expect(await resolveChat(ctx(null), "co-1", "")).toBeFalsy();
  });
});
