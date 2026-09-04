// DO NOT "fix" this to match package.json's name. The npm package is
// published from this fork as @vveliev/paperclip-plugin-telegram, but the
// PLUGIN ID is the key the host stores config, state and — critically —
// secret BINDINGS under. Changing it orphans the installed plugin's board
// token and every linked chat, and the failure is silent: the plugin loads,
// reads empty config, and simply stops polling. The two names are
// deliberately decoupled.
export const PLUGIN_ID = "paperclip-plugin-telegram";
export const PLUGIN_VERSION = "0.8.0";
export const MAX_AGENTS_PER_THREAD = 5;

export const DEFAULT_CONFIG = {
  telegramBotTokenRef: "",
  defaultChatId: "",
  approvalsChatId: "",
  approvalsTopicId: "",
  errorsChatId: "",
  errorsTopicId: "",
  // Routine, FYI-only notices (issue created/done/assigned, agent run
  // started/finished) route here instead of the default chat when set, so
  // they don't bury approvals and errors in the same stream (BLA-618).
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
  allowedTelegramUserIds: [] as string[],
  allowedTelegramChatIds: [] as string[],
  digestMode: "off" as "off" | "daily" | "bidaily" | "tridaily",
  dailyDigestTime: "09:00",
  bidailySecondTime: "17:00",
  tridailyTimes: "07:00,13:00,19:00",
  topicRouting: false,
  maxAgentsPerThread: MAX_AGENTS_PER_THREAD,
  escalationChatId: "",
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Let me check on that - I'll get back to you shortly.",
  // Phase 3: Media Pipeline
  briefAgentId: "",
  briefAgentChatIds: [] as string[],
  transcriptionApiKeyRef: "",
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: 10,
  watchDeduplicationWindowMs: 86400000, // 24h
} as const;

export const AGENT_ERROR_DEDUPLICATION_WINDOW_MS = 30 * 60 * 1000;

// Shared truncation tiers for notification text (issue descriptions,
// excerpts, previews). Centralized so call sites stay in step with each
// other instead of drifting on independently-chosen magic numbers (BLA-361).
export const TRUNCATE_SHORT = 200;
export const TRUNCATE_MEDIUM = 300;
export const TRUNCATE_LONG = 350;

// Cutoff for the error text shown inline in an agent-error notification, and
// reused wherever else a 500-char tier is needed. formatAgentError truncates
// at this length and, when it does, swaps "View Run" for a "Full error"
// button in the same keyboard slot — both link to the run page, so only one
// is ever shown (BLA-362, GIF-139).
export const AGENT_ERROR_TRUNCATE_LENGTH = 500;

export const MAX_CONVERSATION_TURNS = 50;
export const DEFAULT_CONVERSATION_TURNS = 10;

// Telegram's actual, documented hard limit on a sendMessage `text` body
// (https://core.telegram.org/bots/api#sendmessage). Every ad hoc budget in
// this codebase (3500 in commands.ts, 4000 in acp-bridge.ts, 500 in
// media-pipeline.ts, ...) exists because nothing owned this constant — see
// GIF-155. `src/reply.ts` is the one place that is allowed to compare a
// rendered message against it.
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;

export const METRIC_NAMES = {
  sent: "telegram_notifications_sent",
  failed: "telegram_notification_failures",
  commandsHandled: "telegram_commands_handled",
  inboundRouted: "telegram_inbound_routed",
  escalationsCreated: "telegram_escalations_created",
  escalationsResolved: "telegram_escalations_resolved",
  escalationsTimedOut: "telegram_escalations_timed_out",
  mediaProcessed: "telegram_media_processed",
  commandsExecuted: "telegram_custom_commands_executed",
  suggestionsEmitted: "telegram_suggestions_emitted",
  interactionAnswered: "telegram_interaction_answers_submitted",
  keyboardEnabled: "telegram_keyboard_enabled",
  keyboardDisabled: "telegram_keyboard_disabled",
} as const;

// Cross-plugin ACP event names
export const ACP_SPAWN_EVENT = "acp-spawn";
export const ACP_OUTPUT_EVENT = "plugin.paperclip-plugin-acp.output";
