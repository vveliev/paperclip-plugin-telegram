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
// at this length and, when it does, adds a distinct "Full error" button
// rather than relying on "View Run" to double as the link back to the
// untruncated text (BLA-362).
export const AGENT_ERROR_TRUNCATE_LENGTH = 500;

export const MAX_CONVERSATION_TURNS = 50;
export const DEFAULT_CONVERSATION_TURNS = 10;

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
} as const;

// Cross-plugin ACP event names
export const ACP_SPAWN_EVENT = "acp-spawn";
export const ACP_OUTPUT_EVENT = "plugin.paperclip-plugin-acp.output";
