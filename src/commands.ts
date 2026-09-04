import type { PluginContext, PluginEvent, Agent, Issue, Project } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction, type ReplyKeyboardMarkup } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";
import { DEFAULT_CONFIG } from "./config.js";
import { countAgents } from "./agent-status.js";
import { fetchAttention, sendAttentionList, describeDecisionsError, DEFAULT_DISPLAY_LIMIT, DECISIONS_PAGE_SIZE } from "./decisions.js";
import { handleAcpCommand } from "./acp-bridge.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";
import { str } from "./coerce.js";
import { isExternalUrl } from "./url-utils.js";

type BotCommand = {
  command: string;
  description: string;
};

// Leaves headroom below Telegram's 4096-char hard limit for /agents so a
// company with many agents doesn't produce a message the API silently drops.
const AGENTS_MESSAGE_CHAR_BUDGET = 3500;

// The subset of TelegramConfig /settings reports on. Sourced from the
// company's resolved plugin config (see worker.ts's effectiveConfig) — these
// toggles already exist as admin-configured state, so /settings surfaces
// them rather than inventing a parallel per-chat copy.
export type ChatSettingsConfig = {
  topicRouting: boolean;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnIssueAssigned: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentRunStarted: boolean;
  notifyOnAgentRunFinished: boolean;
};

const DEFAULT_SETTINGS_CONFIG: ChatSettingsConfig = {
  topicRouting: DEFAULT_CONFIG.topicRouting,
  notifyOnIssueCreated: DEFAULT_CONFIG.notifyOnIssueCreated,
  notifyOnIssueDone: DEFAULT_CONFIG.notifyOnIssueDone,
  notifyOnIssueAssigned: DEFAULT_CONFIG.notifyOnIssueAssigned,
  notifyOnApprovalCreated: DEFAULT_CONFIG.notifyOnApprovalCreated,
  notifyOnAgentError: DEFAULT_CONFIG.notifyOnAgentError,
  notifyOnAgentRunStarted: DEFAULT_CONFIG.notifyOnAgentRunStarted,
  notifyOnAgentRunFinished: DEFAULT_CONFIG.notifyOnAgentRunFinished,
};

type TopicMappingRecord = {
  projectId?: string;
  projectName: string;
  topicId: string;
};

type TopicMappingValue = string | TopicMappingRecord;
type TopicMap = Record<string, TopicMappingValue>;

// Everything a command's handler might need. Individual handlers only read
// the subset relevant to them — this exists so the table below can hold one
// handler signature instead of thirteen different positional ones.
type CommandContext = {
  ctx: PluginContext;
  token: string;
  chatId: string;
  args: string;
  messageThreadId?: number;
  baseUrl?: string;
  publicUrl?: string;
  companyId?: string;
  boardApiToken?: string;
  maxAgentsPerThread?: number;
  settingsConfig?: ChatSettingsConfig;
  chatType?: string;
};

// Everything handleCommand needs beyond the identifying (chatId, command,
// args) triple. Bundled into one object instead of nine more positional
// parameters — a caller that only cares about, say, chatType no longer has
// to pad seven leading `undefined`s to reach it.
export type HandleCommandOptions = {
  messageThreadId?: number;
  baseUrl?: string;
  publicUrl?: string;
  companyId?: string;
  boardApiToken?: string;
  maxAgentsPerThread?: number;
  settingsConfig?: ChatSettingsConfig;
  chatType?: string;
};

type HelpEntry = {
  // Full invocation grammar, e.g. "/acp <spawn|status|cancel|close>". Inlined
  // here so a first-time user can see subcommand syntax in /help itself,
  // instead of needing to already know to invoke the bare parent command
  // (/acp, /commands, /topics) to discover it.
  usage: string;
  description: string;
};

type HelpGroup = {
  title: string;
  entries: HelpEntry[];
};

// Every command Telegram, /help, the custom-command override guard, and the
// board-token gate need to agree exists. This is the single source of truth
// those four views are derived from below — a command added here shows up
// everywhere at once, and one that is missing here can't silently exist in
// only one of the four.
type CommandDefinition = {
  command: string;
  // Shown in Telegram's / menu (setMyCommands in worker.ts). Table order is
  // menu order: daily-use commands lead, setup/forum-only ones trail, since
  // that menu is the only discovery path a user has.
  menuDescription: string;
  helpGroup: string;
  // Overrides this entry's position within its help group; defaults to its
  // index in this table. Only needed where help order and menu order
  // disagree — currently just "Agent sessions", which leads with /acp in
  // /help despite /agents coming first in the menu.
  helpOrder?: number;
  helpUsage: string;
  helpDescription: string;
  // Whether dispatching this command needs a resolved board API token (see
  // resolveBoardApiToken in worker.ts) — fetched once per command that
  // actually hits a board-only endpoint, not on every command.
  needsBoardToken: boolean;
  // null for "commands": worker.ts intercepts /commands before handleCommand
  // is ever called, since custom-command CRUD lives in command-registry.ts.
  // It still needs a row here so the menu, help text, and override guard
  // know about it.
  handler: ((cc: CommandContext) => Promise<void>) | null;
};

const HELP_GROUP_ORDER = ["Daily use", "Approvals", "Agent sessions", "Automation", "Setup"];

const COMMANDS: CommandDefinition[] = [
  {
    command: "create",
    menuDescription: "Create a new task for the team",
    helpGroup: "Daily use",
    helpUsage: "/create <title>",
    helpDescription: "Create a new task for the team",
    needsBoardToken: false,
    handler: (cc) => handleCreate(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId, cc.publicUrl || cc.baseUrl, cc.companyId),
  },
  {
    command: "decisions",
    menuDescription: "List decisions waiting on your input",
    helpGroup: "Approvals",
    helpUsage: "/decisions [n|more]",
    helpDescription: "List decisions waiting on your input, optionally more than the default 5",
    needsBoardToken: true,
    handler: (cc) => handleDecisions(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId, cc.baseUrl, cc.publicUrl, cc.companyId, cc.boardApiToken),
  },
  {
    command: "status",
    menuDescription: "Show a quick snapshot: active agents and open issues",
    helpGroup: "Daily use",
    helpUsage: "/status",
    helpDescription: "Quick snapshot: active agents and open issues",
    needsBoardToken: false,
    handler: (cc) => handleStatus(cc.ctx, cc.token, cc.chatId, cc.messageThreadId, cc.publicUrl, cc.companyId),
  },
  {
    command: "issues",
    menuDescription: "List open issues, optionally by project",
    helpGroup: "Daily use",
    helpUsage: "/issues [project]",
    helpDescription: "List open issues, optionally filtered by project",
    needsBoardToken: false,
    handler: (cc) => handleIssues(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId, cc.publicUrl || cc.baseUrl, cc.companyId),
  },
  {
    command: "agents",
    menuDescription: "List all agents and what they're doing",
    helpGroup: "Agent sessions",
    helpOrder: 90, // see the helpOrder note on CommandDefinition — /acp leads in /help
    helpUsage: "/agents",
    helpDescription: "List all agents and what they're doing",
    needsBoardToken: false,
    handler: (cc) => handleAgents(cc.ctx, cc.token, cc.chatId, cc.messageThreadId, cc.publicUrl, cc.companyId),
  },
  {
    command: "approve",
    menuDescription: "Approve a pending request by its ID",
    helpGroup: "Approvals",
    helpUsage: "/approve <id>",
    helpDescription: "Approve a pending request by its ID",
    needsBoardToken: true,
    handler: (cc) => handleApprove(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId, cc.baseUrl, cc.boardApiToken),
  },
  {
    command: "help",
    menuDescription: "Show this list of commands",
    helpGroup: "Daily use",
    helpUsage: "/help",
    helpDescription: "Show this list of commands",
    needsBoardToken: false,
    handler: (cc) => handleHelp(cc.ctx, cc.token, cc.chatId, cc.messageThreadId),
  },
  {
    command: "settings",
    menuDescription: "Show connection, routing, and notification settings",
    helpGroup: "Setup",
    helpUsage: "/settings",
    helpDescription: "Show connection, routing, and notification settings",
    needsBoardToken: false,
    handler: (cc) => handleSettings(cc.ctx, cc.token, cc.chatId, cc.messageThreadId, cc.settingsConfig ?? DEFAULT_SETTINGS_CONFIG),
  },
  {
    command: "keyboard",
    menuDescription: "Toggle a persistent shortcut keyboard (DMs only)",
    helpGroup: "Setup",
    helpUsage: "/keyboard <on|off>",
    helpDescription: "Toggle a persistent shortcut keyboard (DMs only)",
    needsBoardToken: false,
    handler: (cc) => handleKeyboard(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId, cc.chatType),
  },
  {
    command: "acp",
    menuDescription: "Manage agent sessions: start, check, cancel, or close",
    helpGroup: "Agent sessions",
    helpUsage: "/acp <spawn|status|cancel|close>",
    helpDescription: "Start, check, cancel, or close an agent session",
    needsBoardToken: false,
    handler: (cc) => handleAcpCommand(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId, cc.companyId, cc.maxAgentsPerThread),
  },
  {
    command: "commands",
    menuDescription: "Manage custom commands: list, import, run, or delete",
    helpGroup: "Automation",
    helpUsage: "/commands <list|import|run|delete>",
    helpDescription: "Manage custom commands",
    needsBoardToken: false,
    handler: null,
  },
  {
    command: "connect",
    menuDescription: "Link this chat to a Paperclip company",
    helpGroup: "Setup",
    helpUsage: "/connect <company>",
    helpDescription: "Link this chat to a Paperclip company",
    needsBoardToken: false,
    handler: (cc) => handleConnect(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId),
  },
  {
    command: "connect_topic",
    menuDescription: "Map a project to this forum topic (forum groups only)",
    helpGroup: "Setup",
    helpUsage: "/connect_topic <project> [topic-id]",
    helpDescription: "Map a project to this forum topic (forum groups only)",
    needsBoardToken: false,
    handler: (cc) => handleConnectTopic(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId),
  },
  {
    command: "topics",
    menuDescription: "List or remove this chat's forum topic mappings",
    helpGroup: "Setup",
    helpUsage: "/topics <list|remove|clear>",
    helpDescription: "Manage this chat's forum topic mappings",
    needsBoardToken: false,
    handler: (cc) => handleTopicsCommand(cc.ctx, cc.token, cc.chatId, cc.args, cc.messageThreadId),
  },
];

const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.command, c]));

// Derived view #1: the Telegram / menu.
export const BOT_COMMANDS: BotCommand[] = COMMANDS.map((c) => ({ command: c.command, description: c.menuDescription }));

// Derived view #2: /help, grouped by task instead of BOT_COMMANDS's flat menu
// order — a first-time user scanning /help should be able to tell "what do I
// use for approvals" at a glance. Grouping is derived from the same table
// BOT_COMMANDS uses, so the two cannot drift apart the way they used to (a
// test enforced that pairing; it is redundant now that drift is structurally
// impossible, so it has been removed).
export const HELP_GROUPS: HelpGroup[] = HELP_GROUP_ORDER.map((title) => ({
  title,
  entries: COMMANDS
    .map((c, index) => ({ c, sortKey: c.helpOrder ?? index }))
    .filter(({ c }) => c.helpGroup === title)
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ c }) => ({ usage: c.helpUsage, description: c.helpDescription })),
}));

// Derived view #3: the custom-command override guard (command-registry.ts) —
// every name in this table is reserved and cannot be redefined as a custom
// command.
export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(COMMANDS.map((c) => c.command));

// Derived view #4: which commands need a board API token resolved before
// dispatch (worker.ts).
export const BOARD_TOKEN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  COMMANDS.filter((c) => c.needsBoardToken).map((c) => c.command),
);

// Derived view #5: dispatch. Replaces the former 15-case switch — each case
// is now a row in COMMANDS above.
export async function handleCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  command: string,
  args: string,
  opts: HandleCommandOptions = {},
): Promise<void> {
  await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);

  // /start is Telegram's own entry point — the button the client shows on
  // every new chat, so it is the first thing a user ever sends. It has no
  // menu/help entry of its own; it just answers with the same view as /help.
  const lookupCommand = command === "start" ? "help" : command;
  const entry = COMMANDS_BY_NAME.get(lookupCommand);

  if (!entry?.handler) {
    // plain: interpolates the raw command name the user typed
    await sendMessage(ctx, token, chatId, `Unknown command: /${command}. Try /help`, {
      parseMode: undefined,
      messageThreadId: opts.messageThreadId,
    });
    return;
  }

  await entry.handler({ ctx, token, chatId, args, ...opts });
}

/**
 * Parse the optional /decisions argument into a display limit: a bare number
 * ("/decisions 20") sets it directly, "more" is shorthand for one page past
 * the default, and anything else (including no argument) falls back to
 * DEFAULT_DISPLAY_LIMIT. Never throws — an unparseable argument just behaves
 * like no argument, since a wrong /decisions arg is a discovery aid, not a
 * usage error worth its own message.
 */
export function parseDecisionsLimit(args: string): number {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) return DEFAULT_DISPLAY_LIMIT;
  if (trimmed === "more") return DEFAULT_DISPLAY_LIMIT + DECISIONS_PAGE_SIZE;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DISPLAY_LIMIT;
}

/**
 * /decisions — what is actually waiting on a human, from the decision queue
 * behind the /<company>/decisions page.
 *
 * Distinct from /approve: an approval is a yes/no on one request, whereas a
 * decision carries its own option set and applies effects when chosen.
 */
async function handleDecisions(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
  baseUrl: string = "http://localhost:3100",
  publicUrl?: string,
  resolvedCompanyId?: string,
  boardApiToken?: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? (await resolveCompanyId(ctx, chatId));
    const limit = parseDecisionsLimit(args);
    const found = await fetchAttention(ctx, baseUrl, companyId, boardApiToken, limit);
    await sendAttentionList(ctx, token, chatId, found, {
      messageThreadId,
      publicUrl: isExternalUrl(publicUrl) ? publicUrl : undefined,
      baseUrl,
      companyId,
      boardApiToken,
      limit,
    });
  } catch (err) {
    // A raw "403 Board access required" names the symptom and hides the cause,
    // so translate it into what actually went wrong before sending it on.
    ctx.logger.error("Failed to load decisions", { error: String(err) });
    // plain: describeDecisionsError's text is not escaped for MarkdownV2
    await sendMessage(ctx, token, chatId, describeDecisionsError(err), { parseMode: undefined, messageThreadId });
  }
}

async function handleStatus(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  publicUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const agents = await ctx.agents.list({ companyId });
    // Agents report "running" or "idle" (and "paused"/"error" when unavailable).
    // Counting `status === "active"` matched nothing on current hosts, so this
    // line always read "0/N" no matter how many agents were working.
    const counts = countAgents(agents);
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const doneIssues = issues.filter((i: Issue) => i.status === "done");

    const agentLine =
      `${escapeMarkdownV2("🤖")} Agents: *${counts.working}* running, ` +
      `*${escapeMarkdownV2(String(counts.available))}* available` +
      (counts.unavailable > 0 ? escapeMarkdownV2(` (${counts.unavailable} paused/error)`) : "");

    const lines = [
      escapeMarkdownV2("📊") + " *Paperclip Status*",
      "",
      agentLine,
      `${escapeMarkdownV2("📋")} Recent issues: *${escapeMarkdownV2(String(issues.length))}* \\(${escapeMarkdownV2(String(doneIssues.length))} done\\)`,
    ];

    const inlineKeyboard = isExternalUrl(publicUrl)
      ? [[{ text: "Open Dashboard ↗", url: publicUrl! }]]
      : undefined;

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
      inlineKeyboard,
    });
  } catch {
    await sendMessage(ctx, token, chatId, escapeMarkdownV2("📊") + " *Paperclip Status*\n\n" + escapeMarkdownV2("Could not fetch status. Make sure this chat is linked to a company with /connect."), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  }
}

async function handleIssues(
  ctx: PluginContext,
  token: string,
  chatId: string,
  projectFilter: string,
  messageThreadId?: number,
  baseUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const company = await ctx.companies.get(companyId);
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const filtered = projectFilter
      ? issues.filter((i: Issue) => {
          const projName = i.project?.name ?? "";
          return projName.toLowerCase().includes(projectFilter.toLowerCase());
        })
      : issues;

    if (filtered.length === 0) {
      const filter = projectFilter ? ` for project "${projectFilter}"` : "";
      // plain: interpolates the raw projectFilter argument
      await sendMessage(ctx, token, chatId, `No issues found${filter}.`, { parseMode: undefined, messageThreadId });
      return;
    }

    const issuePrefix = company?.issuePrefix;
    const statusEmoji: Record<string, string> = { done: "✅", todo: "📋", in_progress: "🔄", backlog: "📥" };
    const lines = [escapeMarkdownV2("📋") + " *Open Issues*", ""];
    for (const issue of filtered) {
      const emoji = statusEmoji[issue.status] ?? "📋";
      const id = issue.identifier ?? issue.id;
      const idText = issuePrefix && baseUrl
        ? `[${escapeMarkdownV2(id)}](${baseUrl}/${issuePrefix}/issues/${id})`
        : escapeMarkdownV2(id);
      lines.push(`${escapeMarkdownV2(emoji)} ${idText} \\- ${escapeMarkdownV2(issue.title)}`);
    }

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  } catch {
    const filter = projectFilter ? ` for project "${projectFilter}"` : "";
    // plain: interpolates the raw projectFilter argument
    await sendMessage(
      ctx,
      token,
      chatId,
      `Could not fetch issues${filter}. Make sure this chat is linked with /connect.`,
      { parseMode: undefined, messageThreadId },
    );
  }
}

async function handleAgents(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  publicUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const agents = await ctx.agents.list({ companyId });

    if (agents.length === 0) {
      // plain: static status text, no formatting need
      await sendMessage(ctx, token, chatId, "No agents found.", { parseMode: undefined, messageThreadId });
      return;
    }

    const hasLinks = isExternalUrl(publicUrl);
    const statusEmoji: Record<string, string> = { active: "🟢", error: "🔴", paused: "🟡", idle: "⚪", running: "🔵" };
    const lines = [escapeMarkdownV2("🤖") + " *Agents*", ""];
    let shown = 0;
    for (const agent of agents) {
      const emoji = statusEmoji[agent.status] ?? "⚪";
      const line = hasLinks
        ? `${escapeMarkdownV2(emoji)} [${escapeMarkdownV2(agent.name)}](${publicUrl}/agents/${agent.id}) \\- ${escapeMarkdownV2(agent.status)}`
        : `${escapeMarkdownV2(emoji)} *${escapeMarkdownV2(agent.name)}* \\- ${escapeMarkdownV2(agent.status)}`;

      // Stop before the message grows past Telegram's 4096-char hard limit,
      // leaving room for a trailing "and N more" line.
      const projected = lines.join("\n").length + 1 + line.length;
      if (shown > 0 && projected > AGENTS_MESSAGE_CHAR_BUDGET) break;

      lines.push(line);
      shown++;
    }

    const remaining = agents.length - shown;
    if (remaining > 0) {
      lines.push("", escapeMarkdownV2(`…and ${remaining} more`));
    }

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  } catch {
    // plain: static status text, no formatting need
    await sendMessage(
      ctx,
      token,
      chatId,
      "Could not fetch agents. Make sure this chat is linked with /connect.",
      { parseMode: undefined, messageThreadId },
    );
  }
}

async function handleApprove(
  ctx: PluginContext,
  token: string,
  chatId: string,
  approvalId: string,
  messageThreadId?: number,
  baseUrl: string = "http://localhost:3100",
  boardApiToken?: string,
): Promise<void> {
  if (!approvalId.trim()) {
    // plain: static usage text, no formatting need
    await sendMessage(ctx, token, chatId, "Usage: /approve <approval-id>", {
      parseMode: undefined,
      messageThreadId,
    });
    return;
  }

  try {
    await fetchPaperclipApi(
      ctx,
      `${baseUrl}/api/approvals/${approvalId.trim()}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildPaperclipAuthHeaders(boardApiToken),
        },
        body: JSON.stringify({ decidedByUserId: `telegram:${chatId}` }),
      },
    );

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("✅")} *Approved*: \`${escapeMarkdownV2(approvalId.trim())}\``,
      { parseMode: "MarkdownV2", messageThreadId },
    );
  } catch (err) {
    // plain: interpolates a raw upstream error message
    await sendMessage(
      ctx,
      token,
      chatId,
      `Failed to approve ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
      { parseMode: undefined, messageThreadId },
    );
  }
}

async function handleHelp(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  const lines = [escapeMarkdownV2("📎") + " *Paperclip Bot Commands*"];

  for (const group of HELP_GROUPS) {
    lines.push("");
    lines.push(`*${escapeMarkdownV2(group.title)}*`);
    for (const entry of group.entries) {
      lines.push(`${escapeMarkdownV2(entry.usage)} \\- ${escapeMarkdownV2(entry.description)}`);
    }
  }

  lines.push("");
  lines.push(escapeMarkdownV2("Run a command with no arguments (e.g. /acp) to see its full usage."));

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

/**
 * /settings — a read-only summary of this chat's connection and the
 * company's notification/routing config. Deliberately does not add new
 * per-chat state: /connect already tracks link status, /connect_topic and
 * /topics already track forum-topic routing, and notification toggles are
 * company-wide config set in the plugin's admin UI. This just surfaces all
 * three in one place so a user can tell what's on without checking three
 * different commands.
 */
async function handleSettings(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId: number | undefined,
  settings: ChatSettingsConfig,
): Promise<void> {
  const link = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  })) as { companyId?: string; companyName?: string; linkedAt?: string } | null;

  const lines = [escapeMarkdownV2("⚙️") + " *Settings*", ""];

  if (link?.companyId) {
    const since = link.linkedAt ? ` \\(since ${escapeMarkdownV2(link.linkedAt.split("T")[0] ?? link.linkedAt)}\\)` : "";
    lines.push(`${escapeMarkdownV2("🔗")} Linked to *${escapeMarkdownV2(link.companyName ?? link.companyId)}*${since}`);
  } else {
    lines.push(`${escapeMarkdownV2("🔗")} ${escapeMarkdownV2("Not linked. Use /connect <company> to link this chat.")}`);
  }

  const topicMap = await getTopicMap(ctx, chatId);
  const topicCount = Object.keys(topicMap).length;
  const topicSuffix = topicCount > 0
    ? ` \\(${topicCount} mapping${topicCount === 1 ? "" : "s"}, see /topics\\)`
    : "";
  lines.push(`${escapeMarkdownV2("🧭")} Topic routing: *${escapeMarkdownV2(settings.topicRouting ? "on" : "off")}*${topicSuffix}`);

  lines.push("");
  lines.push(escapeMarkdownV2("🔔") + " *Notifications*");
  const notificationToggles: Array<[string, boolean]> = [
    ["Issue created", settings.notifyOnIssueCreated],
    ["Issue done", settings.notifyOnIssueDone],
    ["Issue assigned", settings.notifyOnIssueAssigned],
    ["Approval requested", settings.notifyOnApprovalCreated],
    ["Agent error", settings.notifyOnAgentError],
    ["Agent run started", settings.notifyOnAgentRunStarted],
    ["Agent run finished", settings.notifyOnAgentRunFinished],
  ];
  for (const [label, enabled] of notificationToggles) {
    lines.push(`${enabled ? escapeMarkdownV2("✅") : escapeMarkdownV2("⬜")} ${escapeMarkdownV2(label)}`);
  }

  lines.push("");
  lines.push(escapeMarkdownV2("Notification and routing toggles are managed by a company admin in the plugin config."));

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

// The one persistent row this prototype offers: the read-only commands a
// user checks most often. Kept to a single row so it stays visible without
// pushing the text input off-screen on small clients.
const PERSISTENT_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [["/status", "/issues", "/agents", "/decisions", "/help"]],
  resizeKeyboard: true,
  isPersistent: true,
};

/**
 * /keyboard on|off — opt-in persistent reply keyboard prototype;
 * see the reply-keyboard-experiment-eval doc for rationale.
 *
 * Reply keyboards are chat-level, not per-user, so showing one in a group
 * would impose it on everyone in that chat regardless of their own
 * preference. Restricting to DMs keeps this opt-in per person.
 */
async function handleKeyboard(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId: number | undefined,
  chatType: string | undefined,
): Promise<void> {
  if (chatType !== "private") {
    // plain: static status text, no formatting need
    await sendMessage(
      ctx,
      token,
      chatId,
      "/keyboard is only available in a direct message with the bot.",
      { parseMode: undefined, messageThreadId },
    );
    return;
  }

  switch (args.trim().toLowerCase()) {
    case "on":
      // plain: static status text, no formatting need
      await sendMessage(ctx, token, chatId, "Persistent keyboard enabled.", {
        parseMode: undefined,
        messageThreadId,
        keyboard: PERSISTENT_KEYBOARD,
      });
      await ctx.metrics.write(METRIC_NAMES.keyboardEnabled, 1);
      break;
    case "off":
      // plain: static status text, no formatting need
      await sendMessage(ctx, token, chatId, "Persistent keyboard disabled.", {
        parseMode: undefined,
        messageThreadId,
        keyboard: { removeKeyboard: true },
      });
      await ctx.metrics.write(METRIC_NAMES.keyboardDisabled, 1);
      break;
    default:
      // plain: static usage text, no formatting need
      await sendMessage(ctx, token, chatId, "Usage: /keyboard on|off", { parseMode: undefined, messageThreadId });
  }
}

async function handleConnect(
  ctx: PluginContext,
  token: string,
  chatId: string,
  companyArg: string,
  messageThreadId?: number,
): Promise<void> {
  if (!companyArg.trim()) {
    try {
      const companies = await ctx.companies.list();
      const names = companies.map((c) => c.name || c.id).join(", ");
      // plain: interpolates raw company names from ctx.companies.list()
      await sendMessage(ctx, token, chatId, `Usage: /connect <company-name>\nAvailable: ${names || "none"}`, { parseMode: undefined, messageThreadId });
    } catch {
      // plain: static usage text, no formatting need
      await sendMessage(ctx, token, chatId, "Usage: /connect <company-name>", { parseMode: undefined, messageThreadId });
    }
    return;
  }

  try {
    const input = companyArg.trim();
    const companies = await ctx.companies.list();
    const match = companies.find(
      (c) =>
        c.id === input ||
        c.name?.toLowerCase() === input.toLowerCase(),
    );

    if (!match) {
      const names = companies.map((c) => c.name || c.id).join(", ");
      // plain: interpolates raw user input and company names
      await sendMessage(
        ctx,
        token,
        chatId,
        `Company "${input}" not found. Available: ${names || "none"}`,
        { parseMode: undefined, messageThreadId },
      );
      return;
    }

    const existing = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `chat_${chatId}`,
    }) as { companyId?: string } | null;
    if (existing?.companyId === match.id) {
      ctx.logger.info("Chat already linked to company", { chatId, companyId: match.id, companyName: match.name });
      return;
    }

    // Inbound: chat → company (for commands like /status)
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `chat_${chatId}` },
      { companyId: match.id, companyName: match.name ?? input, linkedAt: new Date().toISOString() },
    );

    // Outbound: company → chat (for notifications)
    await ctx.state.set(
      { scopeKind: "company", scopeId: match.id, stateKey: "telegram-chat" },
      chatId,
    );

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("🔗")} ${escapeMarkdownV2("Linked this chat to company:")} *${escapeMarkdownV2(match.name ?? input)}*`,
      { parseMode: "MarkdownV2", messageThreadId },
    );

    ctx.logger.info("Chat linked to company", { chatId, companyId: match.id, companyName: match.name });
  } catch (err) {
    // plain: interpolates a raw upstream error message
    await sendMessage(
      ctx,
      token,
      chatId,
      `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      { parseMode: undefined, messageThreadId },
    );
  }
}

async function handleCreate(
  ctx: PluginContext,
  token: string,
  chatId: string,
  titleArg: string,
  messageThreadId?: number,
  linkBaseUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  const title = titleArg.trim();
  if (!title) {
    // plain: static usage text, no formatting need
    await sendMessage(ctx, token, chatId, "Usage: /create <task title>", { parseMode: undefined, messageThreadId });
    return;
  }

  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const company = await ctx.companies.get(companyId);
    const issuePrefix = company?.issuePrefix;
    const projectId = await resolveProjectIdForTopic(ctx, chatId, companyId, messageThreadId);

    // Find the CEO agent to assign to
    const agents = await ctx.agents.list({ companyId });
    const ceo = agents.find((a: Agent) => a.role === "ceo" && a.status !== "paused" && a.status !== "error");

    // Create the issue WITHOUT assignee first, then update with both status and assignee.
    // This ordering is load-bearing: the issue_assigned wake only fires when the assignee
    // *transitions* from null to an agent. If we set the assignee at creation time, there's
    // no transition and the agent never gets woken.
    let issue = await ctx.issues.create({ companyId, title, ...(projectId ? { projectId } : {}) });
    if (ceo) {
      issue = await ctx.issues.update(
        issue.id,
        { status: "todo", assigneeAgentId: ceo.id },
        companyId,
      );
    } else {
      // No CEO to assign to — still bump status to todo so it's visible in the backlog
      issue = await ctx.issues.update(issue.id, { status: "todo" }, companyId);
    }

    const id = issue.identifier ?? issue.id;
    const hasLink = linkBaseUrl && isExternalUrl(linkBaseUrl) && issuePrefix;
    const idText = hasLink
      ? `[${escapeMarkdownV2(id)}](${linkBaseUrl}/${issuePrefix}/issues/${id})`
      : `\`${escapeMarkdownV2(id)}\``;
    const assigneeText = ceo ? ` ${escapeMarkdownV2("→")} *${escapeMarkdownV2(ceo.name)}*` : "";

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("✅")} *Task Created*: ${idText}${assigneeText}\n${escapeMarkdownV2(title)}`,
      { parseMode: "MarkdownV2", messageThreadId },
    );
  } catch (err) {
    // plain: interpolates a raw upstream error message
    await sendMessage(
      ctx,
      token,
      chatId,
      `Failed to create task: ${err instanceof Error ? err.message : String(err)}`,
      { parseMode: undefined, messageThreadId },
    );
  }
}

// Escaped once here instead of hand-escaped per call site (three of them
// below) so the one escaping path stays the source of truth — a hand-escaped
// literal previously missed `>`, a MarkdownV2-reserved character.
const CONNECT_TOPIC_USAGE = escapeMarkdownV2("Usage: /connect_topic <project-name> [topic-id]");

export async function handleConnectTopic(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
): Promise<void> {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    await sendMessage(ctx, token, chatId, CONNECT_TOPIC_USAGE, {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  const parts = trimmedArgs.split(/\s+/);
  if (parts.length < 2 && !messageThreadId) {
    await sendMessage(ctx, token, chatId, CONNECT_TOPIC_USAGE, {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  let topicId: string;
  let projectNameInput: string;
  const explicitTopicId = parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]);
  if (explicitTopicId) {
    topicId = parts.pop()!;
    projectNameInput = parts.join(" ");
  } else {
    if (!messageThreadId) {
      await sendMessage(ctx, token, chatId, CONNECT_TOPIC_USAGE, {
        parseMode: "MarkdownV2",
        messageThreadId,
      });
      return;
    }
    topicId = String(messageThreadId);
    projectNameInput = parts.join(" ");
  }

  let companyId: string;
  try {
    companyId = await resolveCompanyId(ctx, chatId);
  } catch {
    // plain: static status text, no formatting need
    await sendMessage(ctx, token, chatId, "This chat is not linked to a Paperclip company. Use /connect first.", { parseMode: undefined, messageThreadId });
    return;
  }
  const project = await resolveProjectByName(ctx, companyId, projectNameInput);
  if (!project) {
    await sendProjectNotFoundMessage(ctx, token, chatId, companyId, projectNameInput, messageThreadId);
    return;
  }

  const topicMap = await getTopicMap(ctx, chatId);
  const existingKey = findTopicMapKey(topicMap, project.name) ?? findTopicMapKey(topicMap, projectNameInput);
  if (existingKey && existingKey !== project.name) {
    delete topicMap[existingKey];
  }
  topicMap[project.name] = { projectId: project.id, projectName: project.name, topicId };

  await setTopicMap(ctx, chatId, topicMap);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("🔗")} ${escapeMarkdownV2(`Mapped project "${project.name}" to topic ${topicId}`)}`,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("Topic mapped", { chatId, projectId: project.id, projectName: project.name, topicId });
}

async function handleTopicsCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
): Promise<void> {
  const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);

  switch (subcommand.toLowerCase()) {
    case "list":
      await handleTopicsList(ctx, token, chatId, messageThreadId);
      break;
    case "remove":
      await handleTopicsRemove(ctx, token, chatId, rest.join(" "), messageThreadId);
      break;
    case "clear":
      await handleTopicsClear(ctx, token, chatId, messageThreadId);
      break;
    default:
      await sendTopicsUsage(ctx, token, chatId, messageThreadId);
  }
}

async function handleTopicsList(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  const topicMap = await getTopicMap(ctx, chatId);
  const entries = Object.entries(topicMap);

  if (entries.length === 0) {
    // plain: static status text, no formatting need
    await sendMessage(ctx, token, chatId, "No topic mappings found for this chat.", { parseMode: undefined, messageThreadId });
    return;
  }

  const lines = [
    escapeMarkdownV2("🧭") + " *Topic Mappings*",
    "",
    ...entries.map(([key, value]) => {
      const mapping = normalizeTopicMapping(key, value);
      return `• ${escapeMarkdownV2(mapping.projectName)} ${escapeMarkdownV2("→")} ${escapeMarkdownV2(mapping.topicId)}`;
    }),
  ];

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

async function handleTopicsRemove(
  ctx: PluginContext,
  token: string,
  chatId: string,
  projectName: string,
  messageThreadId?: number,
): Promise<void> {
  const input = projectName.trim();
  if (!input) {
    await sendMessage(ctx, token, chatId, escapeMarkdownV2("Usage: /topics remove <project-name>"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  const topicMap = await getTopicMap(ctx, chatId);
  const key = findTopicMapKey(topicMap, input);
  if (!key) {
    // plain: interpolates raw user input
    await sendMessage(ctx, token, chatId, `No topic mapping found for "${input}".`, { parseMode: undefined, messageThreadId });
    return;
  }

  const mapping = normalizeTopicMapping(key, topicMap[key]);
  delete topicMap[key];
  await setTopicMap(ctx, chatId, topicMap);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("🗑️")} ${escapeMarkdownV2(`Removed topic mapping for "${mapping.projectName}".`)}`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function handleTopicsClear(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  await setTopicMap(ctx, chatId, {});
  // plain: static status text, no formatting need
  await sendMessage(ctx, token, chatId, "Cleared all topic mappings for this chat.", { parseMode: undefined, messageThreadId });
}

async function sendTopicsUsage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  await sendMessage(
    ctx,
    token,
    chatId,
    [
      escapeMarkdownV2("🧭") + " *Topic Commands*",
      "",
      `${escapeMarkdownV2("/topics list -")} ${escapeMarkdownV2("Show mappings for this chat")}`,
      `${escapeMarkdownV2("/topics remove <project-name> -")} ${escapeMarkdownV2("Remove one mapping")}`,
      `${escapeMarkdownV2("/topics clear -")} ${escapeMarkdownV2("Remove all mappings for this chat")}`,
    ].join("\n"),
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function resolveProjectByName(
  ctx: PluginContext,
  companyId: string,
  projectName: string,
): Promise<Project | undefined> {
  const input = projectName.trim();
  if (!input) return undefined;

  const projects = await ctx.projects.list({ companyId, limit: 100 });
  return projects.find((project) => project.id === input)
    ?? projects.find((project) => project.name === input)
    ?? projects.find((project) => project.name?.toLowerCase() === input.toLowerCase());
}

async function sendProjectNotFoundMessage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  companyId: string,
  projectName: string,
  messageThreadId?: number,
): Promise<void> {
  try {
    const projects = await ctx.projects.list({ companyId, limit: 100 });
    const names = projects.map((project) => project.name || project.id).filter(Boolean).join(", ");
    // plain: interpolates raw user input and project names
    await sendMessage(
      ctx,
      token,
      chatId,
      `Project "${projectName.trim()}" not found. Available: ${names || "none"}`,
      { parseMode: undefined, messageThreadId },
    );
  } catch {
    // plain: interpolates raw user input
    await sendMessage(ctx, token, chatId, `Project "${projectName.trim()}" not found.`, { parseMode: undefined, messageThreadId });
  }
}

async function getTopicMap(ctx: PluginContext, chatId: string): Promise<TopicMap> {
  const existing = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  });
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return {};
  return existing as TopicMap;
}

async function setTopicMap(ctx: PluginContext, chatId: string, topicMap: TopicMap): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `topic-map-${chatId}` },
    topicMap,
  );
}

function findTopicMapKey(topicMap: TopicMap, projectName: string): string | undefined {
  const input = projectName.trim().toLowerCase();
  if (!input) return undefined;

  return Object.entries(topicMap).find(([key, value]) => {
    const mapping = normalizeTopicMapping(key, value);
    return key.toLowerCase() === input
      || mapping.projectName.toLowerCase() === input
      || mapping.projectId?.toLowerCase() === input;
  })?.[0];
}

function normalizeTopicMapping(projectName: string, value: TopicMappingValue): TopicMappingRecord {
  if (typeof value === "string") {
    return { projectName, topicId: value };
  }
  return {
    projectId: value.projectId,
    projectName: value.projectName || projectName,
    topicId: String(value.topicId),
  };
}

export async function getTopicForProject(
  ctx: PluginContext,
  chatId: string,
  projectName?: string,
): Promise<number | undefined> {
  if (!projectName) return undefined;
  const topicMap = await getTopicMap(ctx, chatId);
  const key = findTopicMapKey(topicMap, projectName);
  if (!key) return undefined;
  const mapping = normalizeTopicMapping(key, topicMap[key]);
  return Number(mapping.topicId);
}

async function getProjectNameForTopic(
  ctx: PluginContext,
  chatId: string,
  messageThreadId?: number,
): Promise<string | undefined> {
  if (!messageThreadId) return undefined;
  const topicMap = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  })) as Record<string, string> | null;
  if (!topicMap) return undefined;

  const topicId = String(messageThreadId);
  const match = Object.entries(topicMap).find(([, mappedTopicId]) => mappedTopicId === topicId);
  return match?.[0];
}

async function resolveProjectIdForTopic(
  ctx: PluginContext,
  chatId: string,
  companyId: string,
  messageThreadId?: number,
): Promise<string | undefined> {
  const projectName = await getProjectNameForTopic(ctx, chatId, messageThreadId);
  if (!projectName) return undefined;

  try {
    const projects = await ctx.projects.list({ companyId, limit: 100 });
    const exactMatch = projects.find((project) => project.name === projectName);
    if (exactMatch) return exactMatch.id;
    return projects.find((project) => project.name?.toLowerCase() === projectName.toLowerCase())?.id;
  } catch {
    return undefined;
  }
}

export async function resolveNotificationThreadId(
  ctx: PluginContext,
  chatId: string,
  event: PluginEvent,
  topicRouting: boolean,
): Promise<number | undefined> {
  if (!topicRouting) return undefined;
  const projectName = await resolveEventProjectName(ctx, event);
  return getTopicForProject(ctx, chatId, projectName);
}

async function resolveEventProjectName(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<string | undefined> {
  const payload = event.payload as Record<string, unknown>;
  const payloadProjectName = payload.projectName ? str(payload.projectName) : undefined;
  if (payloadProjectName) return payloadProjectName;

  const payloadProjectId = payload.projectId ? str(payload.projectId) : undefined;
  if (payloadProjectId) {
    try {
      const project = await ctx.projects.get(payloadProjectId, event.companyId);
      if (project?.name) return project.name;
    } catch {
      return undefined;
    }
  }

  if (event.entityType !== "issue" || !event.entityId) return undefined;
  try {
    const issue = await ctx.issues.get(event.entityId, event.companyId);
    if (!issue?.projectId) return undefined;
    const project = await ctx.projects.get(issue.projectId, event.companyId);
    return project?.name;
  } catch {
    return undefined;
  }
}

async function resolveCompanyId(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  }) as { companyId?: string; companyName?: string } | null;
  const companyId = mapping?.companyId ?? mapping?.companyName;
  if (!companyId) {
    throw new Error("This chat is not linked to a Paperclip company. Use /connect first.");
  }
  return companyId;
}
