/**
 * Single source of truth for the plugin's instance configuration: the type,
 * the defaults, and how untyped host-delivered JSON becomes a
 * `TelegramConfig`. `manifest.ts` and the worker/UI decoders all read
 * through here instead of re-typing or re-coercing the same keys
 * independently.
 */
import { MAX_AGENTS_PER_THREAD } from "./constants.js";

export type TelegramConfig = {
  telegramBotTokenRef: string;
  defaultChatId: string;
  approvalsChatId: string;
  approvalsTopicId: string;
  errorsChatId: string;
  errorsTopicId: string;
  activityChatId: string;
  activityTopicId: string;
  digestChatId: string;
  digestTopicId: string;
  paperclipBaseUrl: string;
  paperclipBoardApiTokenRef: string;
  paperclipPublicUrl: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnIssueAssigned: boolean;
  onlyNotifyIfAssignedTo: string;
  notifyOnApprovalCreated: boolean;
  onlyNotifyBoardApprovals: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentRunStarted: boolean;
  notifyOnAgentRunFinished: boolean;
  enableCommands: boolean;
  enableInbound: boolean;
  allowedTelegramUserIds: string[];
  allowedTelegramChatIds: string[];
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
  topicRouting: boolean;
  maxAgentsPerThread: number;
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
  // Phase 3: Media Pipeline
  briefAgentId: string;
  briefAgentChatIds: string[];
  transcriptionApiKeyRef: string;
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

export const DEFAULT_CONFIG: TelegramConfig = {
  telegramBotTokenRef: "",
  defaultChatId: "",
  approvalsChatId: "",
  approvalsTopicId: "",
  errorsChatId: "",
  errorsTopicId: "",
  // Routine, FYI-only notices (issue created/done/assigned, agent run
  // started/finished) route here instead of the default chat when set, so
  // they don't bury approvals and errors in the same stream.
  activityChatId: "",
  activityTopicId: "",
  digestChatId: "",
  digestTopicId: "",
  paperclipBaseUrl: "http://localhost:3100",
  paperclipBoardApiTokenRef: "",
  paperclipPublicUrl: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnIssueAssigned: false,
  onlyNotifyIfAssignedTo: "",
  notifyOnApprovalCreated: true,
  onlyNotifyBoardApprovals: false,
  notifyOnAgentError: true,
  notifyOnAgentRunStarted: false,
  notifyOnAgentRunFinished: false,
  enableCommands: true,
  enableInbound: true,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
  digestMode: "off",
  dailyDigestTime: "09:00",
  bidailySecondTime: "17:00",
  tridailyTimes: "07:00,13:00,19:00",
  topicRouting: false,
  maxAgentsPerThread: MAX_AGENTS_PER_THREAD,
  escalationChatId: "",
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Let me check on that - I'll get back to you shortly.",
  briefAgentId: "",
  briefAgentChatIds: [],
  transcriptionApiKeyRef: "",
  maxSuggestionsPerHourPerCompany: 10,
  watchDeduplicationWindowMs: 86400000, // 24h
};

/**
 * Config keys whose value is a secret reference. `manifest.ts`'s
 * `instanceConfigSchema` declares exactly these three explicitly (everything
 * else falls through `additionalProperties: true`, see the comment there);
 * `config.test.ts` asserts the two stay in sync so a new *Ref key added to
 * one and not the other fails the build instead of shipping quietly.
 */
export const SECRET_REF_CONFIG_KEYS = [
  "telegramBotTokenRef",
  "paperclipBoardApiTokenRef",
  "transcriptionApiKeyRef",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function asDigestMode(config: Record<string, unknown>): TelegramConfig["digestMode"] {
  const value = config.digestMode;
  if (value === "daily" || value === "bidaily" || value === "tridaily") return value;
  // Configs saved before digestMode existed stored a dailyDigestEnabled
  // boolean instead; honor it once, then digestMode takes over.
  if (config.dailyDigestEnabled === true) return "daily";
  return "off";
}

function asEscalationDefaultAction(value: unknown): TelegramConfig["escalationDefaultAction"] {
  return value === "auto_reply" || value === "close" ? value : "defer";
}

/**
 * Decode host-delivered, untyped config JSON into a `TelegramConfig`. Every
 * field is coerced independently and falls back to `DEFAULT_CONFIG` on a
 * missing, empty, or wrongly-typed value, so a partial or malformed payload
 * never produces a value the rest of the plugin has to re-guard against.
 */
export function decode(raw: unknown): TelegramConfig {
  const config = isRecord(raw) ? raw : {};
  return {
    telegramBotTokenRef: asString(config.telegramBotTokenRef, DEFAULT_CONFIG.telegramBotTokenRef),
    defaultChatId: asString(config.defaultChatId, DEFAULT_CONFIG.defaultChatId),
    approvalsChatId: asString(config.approvalsChatId, DEFAULT_CONFIG.approvalsChatId),
    approvalsTopicId: asString(config.approvalsTopicId, DEFAULT_CONFIG.approvalsTopicId),
    errorsChatId: asString(config.errorsChatId, DEFAULT_CONFIG.errorsChatId),
    errorsTopicId: asString(config.errorsTopicId, DEFAULT_CONFIG.errorsTopicId),
    activityChatId: asString(config.activityChatId, DEFAULT_CONFIG.activityChatId),
    activityTopicId: asString(config.activityTopicId, DEFAULT_CONFIG.activityTopicId),
    digestChatId: asString(config.digestChatId, DEFAULT_CONFIG.digestChatId),
    digestTopicId: asString(config.digestTopicId, DEFAULT_CONFIG.digestTopicId),
    paperclipBaseUrl: asString(config.paperclipBaseUrl, DEFAULT_CONFIG.paperclipBaseUrl),
    paperclipBoardApiTokenRef: asString(
      config.paperclipBoardApiTokenRef,
      DEFAULT_CONFIG.paperclipBoardApiTokenRef,
    ),
    paperclipPublicUrl: asString(config.paperclipPublicUrl, DEFAULT_CONFIG.paperclipPublicUrl),
    notifyOnIssueCreated: asBoolean(config.notifyOnIssueCreated, DEFAULT_CONFIG.notifyOnIssueCreated),
    notifyOnIssueDone: asBoolean(config.notifyOnIssueDone, DEFAULT_CONFIG.notifyOnIssueDone),
    notifyOnIssueAssigned: asBoolean(config.notifyOnIssueAssigned, DEFAULT_CONFIG.notifyOnIssueAssigned),
    onlyNotifyIfAssignedTo: asString(config.onlyNotifyIfAssignedTo, DEFAULT_CONFIG.onlyNotifyIfAssignedTo),
    notifyOnApprovalCreated: asBoolean(config.notifyOnApprovalCreated, DEFAULT_CONFIG.notifyOnApprovalCreated),
    onlyNotifyBoardApprovals: asBoolean(
      config.onlyNotifyBoardApprovals,
      DEFAULT_CONFIG.onlyNotifyBoardApprovals,
    ),
    notifyOnAgentError: asBoolean(config.notifyOnAgentError, DEFAULT_CONFIG.notifyOnAgentError),
    notifyOnAgentRunStarted: asBoolean(config.notifyOnAgentRunStarted, DEFAULT_CONFIG.notifyOnAgentRunStarted),
    notifyOnAgentRunFinished: asBoolean(
      config.notifyOnAgentRunFinished,
      DEFAULT_CONFIG.notifyOnAgentRunFinished,
    ),
    enableCommands: asBoolean(config.enableCommands, DEFAULT_CONFIG.enableCommands),
    enableInbound: asBoolean(config.enableInbound, DEFAULT_CONFIG.enableInbound),
    allowedTelegramUserIds: asStringArray(config.allowedTelegramUserIds),
    allowedTelegramChatIds: asStringArray(config.allowedTelegramChatIds),
    digestMode: asDigestMode(config),
    dailyDigestTime: asString(config.dailyDigestTime, DEFAULT_CONFIG.dailyDigestTime),
    bidailySecondTime: asString(config.bidailySecondTime, DEFAULT_CONFIG.bidailySecondTime),
    tridailyTimes: asString(config.tridailyTimes, DEFAULT_CONFIG.tridailyTimes),
    topicRouting: asBoolean(config.topicRouting, DEFAULT_CONFIG.topicRouting),
    maxAgentsPerThread: asNumber(config.maxAgentsPerThread, DEFAULT_CONFIG.maxAgentsPerThread),
    escalationChatId: asString(config.escalationChatId, DEFAULT_CONFIG.escalationChatId),
    escalationTimeoutMs: asNumber(config.escalationTimeoutMs, DEFAULT_CONFIG.escalationTimeoutMs),
    escalationDefaultAction: asEscalationDefaultAction(config.escalationDefaultAction),
    escalationHoldMessage: asString(config.escalationHoldMessage, DEFAULT_CONFIG.escalationHoldMessage),
    briefAgentId: asString(config.briefAgentId, DEFAULT_CONFIG.briefAgentId),
    briefAgentChatIds: asStringArray(config.briefAgentChatIds),
    transcriptionApiKeyRef: asString(config.transcriptionApiKeyRef, DEFAULT_CONFIG.transcriptionApiKeyRef),
    maxSuggestionsPerHourPerCompany: asNumber(
      config.maxSuggestionsPerHourPerCompany,
      DEFAULT_CONFIG.maxSuggestionsPerHourPerCompany,
    ),
    watchDeduplicationWindowMs: asNumber(
      config.watchDeduplicationWindowMs,
      DEFAULT_CONFIG.watchDeduplicationWindowMs,
    ),
  };
}
