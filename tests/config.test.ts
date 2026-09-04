import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, SECRET_REF_CONFIG_KEYS, decode } from "../src/config.js";
import manifest from "../src/manifest.js";

describe("config drift", () => {
  it("keeps the manifest's declared secret-ref properties and SECRET_REF_CONFIG_KEYS in sync", () => {
    const schemaProps = manifest.instanceConfigSchema?.properties ?? {};
    expect(Object.keys(schemaProps).sort()).toEqual([...SECRET_REF_CONFIG_KEYS].sort());
  });

  it("declares every secret-ref key as a string field in DEFAULT_CONFIG, with a secret-ref manifest entry", () => {
    const schemaProps = manifest.instanceConfigSchema?.properties as Record<
      string,
      { type?: unknown; format?: unknown }
    >;
    for (const key of SECRET_REF_CONFIG_KEYS) {
      expect(DEFAULT_CONFIG).toHaveProperty(key);
      expect(typeof DEFAULT_CONFIG[key]).toBe("string");
      expect(schemaProps[key]?.format).toBe("secret-ref");
      expect(schemaProps[key]?.type).toEqual(["string", "object"]);
    }
  });
});

describe("decode", () => {
  it("returns DEFAULT_CONFIG for a missing, null, or non-object payload", () => {
    expect(decode(undefined)).toEqual(DEFAULT_CONFIG);
    expect(decode(null)).toEqual(DEFAULT_CONFIG);
    expect(decode("not an object")).toEqual(DEFAULT_CONFIG);
    expect(decode(42)).toEqual(DEFAULT_CONFIG);
    expect(decode([])).toEqual(DEFAULT_CONFIG);
  });

  it("is idempotent: decoding an already-decoded config returns the same values", () => {
    expect(decode(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it("passes through well-typed values for every field", () => {
    const raw = {
      telegramBotTokenRef: "tok",
      defaultChatId: "chat-1",
      approvalsChatId: "chat-2",
      approvalsTopicId: "topic-2",
      errorsChatId: "chat-3",
      errorsTopicId: "topic-3",
      activityChatId: "chat-4",
      activityTopicId: "topic-4",
      digestChatId: "chat-5",
      digestTopicId: "topic-5",
      paperclipBaseUrl: "https://example.test",
      paperclipBoardApiTokenRef: "board-ref",
      paperclipPublicUrl: "https://public.test",
      notifyOnIssueCreated: false,
      notifyOnIssueDone: false,
      notifyOnIssueAssigned: true,
      onlyNotifyIfAssignedTo: "user-1",
      notifyOnApprovalCreated: false,
      onlyNotifyBoardApprovals: true,
      notifyOnAgentError: false,
      notifyOnAgentRunStarted: true,
      notifyOnAgentRunFinished: true,
      enableCommands: false,
      enableInbound: false,
      allowedTelegramUserIds: ["1", "2"],
      allowedTelegramChatIds: ["3", "4"],
      digestMode: "bidaily",
      dailyDigestTime: "10:00",
      bidailySecondTime: "18:00",
      tridailyTimes: "08:00,14:00,20:00",
      topicRouting: true,
      maxAgentsPerThread: 9,
      escalationChatId: "chat-6",
      escalationTimeoutMs: 1000,
      escalationDefaultAction: "close",
      escalationHoldMessage: "hold on",
      briefAgentId: "agent-1",
      briefAgentChatIds: ["5", "6"],
      transcriptionApiKeyRef: "transcribe-ref",
      maxSuggestionsPerHourPerCompany: 20,
      watchDeduplicationWindowMs: 1234,
    };

    expect(decode(raw)).toEqual(raw);
  });

  it("falls back to DEFAULT_CONFIG per-field on missing, empty, or wrongly-typed values", () => {
    const decoded = decode({
      defaultChatId: 5, // wrong type
      paperclipBaseUrl: "", // empty string falls back to the non-empty default
      notifyOnIssueCreated: "yes", // wrong type
      maxAgentsPerThread: "9", // wrong type
      allowedTelegramUserIds: "not-an-array",
      escalationHoldMessage: "",
    });

    expect(decoded.defaultChatId).toBe(DEFAULT_CONFIG.defaultChatId);
    expect(decoded.paperclipBaseUrl).toBe(DEFAULT_CONFIG.paperclipBaseUrl);
    expect(decoded.notifyOnIssueCreated).toBe(DEFAULT_CONFIG.notifyOnIssueCreated);
    expect(decoded.maxAgentsPerThread).toBe(DEFAULT_CONFIG.maxAgentsPerThread);
    expect(decoded.allowedTelegramUserIds).toEqual([]);
    expect(decoded.escalationHoldMessage).toBe(DEFAULT_CONFIG.escalationHoldMessage);
  });

  it("trims and drops non-string entries from string-array fields", () => {
    const decoded = decode({
      allowedTelegramUserIds: [" 1 ", "", 2, null, "3"],
    });
    expect(decoded.allowedTelegramUserIds).toEqual(["1", "3"]);
  });

  it("rejects a non-finite number and falls back to the default", () => {
    expect(decode({ escalationTimeoutMs: Infinity }).escalationTimeoutMs).toBe(
      DEFAULT_CONFIG.escalationTimeoutMs,
    );
    expect(decode({ escalationTimeoutMs: Number.NaN }).escalationTimeoutMs).toBe(
      DEFAULT_CONFIG.escalationTimeoutMs,
    );
  });

  it.each(["daily", "bidaily", "tridaily"] as const)("accepts digestMode %s", (mode) => {
    expect(decode({ digestMode: mode }).digestMode).toBe(mode);
  });

  it("falls back to off for an unrecognized digestMode", () => {
    expect(decode({ digestMode: "hourly" }).digestMode).toBe("off");
    expect(decode({}).digestMode).toBe("off");
  });

  it("honors a legacy dailyDigestEnabled boolean when digestMode is unset", () => {
    expect(decode({ dailyDigestEnabled: true }).digestMode).toBe("daily");
    expect(decode({ dailyDigestEnabled: false }).digestMode).toBe("off");
  });

  it("prefers an explicit digestMode over the legacy dailyDigestEnabled flag", () => {
    expect(decode({ dailyDigestEnabled: true, digestMode: "tridaily" }).digestMode).toBe("tridaily");
  });

  it.each(["auto_reply", "close"] as const)("accepts escalationDefaultAction %s", (action) => {
    expect(decode({ escalationDefaultAction: action }).escalationDefaultAction).toBe(action);
  });

  it("falls back to defer for an unrecognized escalationDefaultAction", () => {
    expect(decode({ escalationDefaultAction: "ignore" }).escalationDefaultAction).toBe("defer");
    expect(decode({}).escalationDefaultAction).toBe("defer");
  });
});
