import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const isForumMock = vi.fn(async () => false);
vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
  return { ...actual, isForum: isForumMock };
});

const {
  makeUpdateDedupe,
  normalizeAgentErrorMessage,
  resolveChat,
  parseTopicId,
  validateConfiguredTopicIds,
  resolveDigestThreadId,
} = await import("../src/worker.js");

/**
 * BLA-163. worker.ts sat at 33% because its decision logic was module-private:
 * which updates are duplicates, whether a topic id is usable. None of it
 * could be reached from a test, so none of it was checked.
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

  it("validates activityTopicId the same way as the other routed topics (BLA-618)", () => {
    expect(validateConfiguredTopicIds({ activityTopicId: "77" })).toEqual([]);
    const errors = validateConfiguredTopicIds({ activityTopicId: "general" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("activityTopicId");
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
