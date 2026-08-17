import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";

// --- Types ---

type WorkflowStepBase = {
  id: string;
  name?: string;
};

type FetchIssueStep = WorkflowStepBase & {
  type: "fetch_issue";
  issueId: string; // supports {{arg1}} template
};

type InvokeAgentStep = WorkflowStepBase & {
  type: "invoke_agent";
  agentId: string;
  prompt: string; // supports {{prev.result}}, {{arg1}} etc.
};

type HttpRequestStep = WorkflowStepBase & {
  type: "http_request";
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
};

type SendMessageStep = WorkflowStepBase & {
  type: "send_message";
  text: string;
};

type CreateIssueStep = WorkflowStepBase & {
  type: "create_issue";
  title: string;
  description?: string;
  projectId?: string;
  assigneeAgentId?: string;
};

type WaitApprovalStep = WorkflowStepBase & {
  type: "wait_approval";
  prompt: string;
  timeoutMs?: number;
};

type SetStateStep = WorkflowStepBase & {
  type: "set_state";
  key: string;
  value: string;
};

type WorkflowStep =
  | FetchIssueStep
  | InvokeAgentStep
  | HttpRequestStep
  | SendMessageStep
  | CreateIssueStep
  | WaitApprovalStep
  | SetStateStep;

type CustomCommand = {
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdBy: string;
  createdAt: string;
};

type StepResult = {
  stepId: string;
  result: string;
  data?: unknown;
};

// --- Built-in commands ---

const BUILTIN_COMMANDS = new Set([
  "status", "issues", "agents", "approve", "help",
  "connect", "connect_topic", "topics", "acp", "commands",
]);

// --- Command registry ---

export async function handleCommandsCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";

  if (!companyId && ["list", "import", "delete", "run"].includes(subcommand)) {
    await sendMessage(ctx, token, chatId, "This chat is not linked to a Paperclip company. Use /connect first.", { messageThreadId });
    return;
  }

  switch (subcommand) {
    case "list":
      await listCommands(ctx, token, chatId, messageThreadId, companyId);
      break;
    case "import":
      await importCommand(ctx, token, chatId, parts.slice(1).join(" "), messageThreadId, companyId);
      break;
    case "delete":
      await deleteCommand(ctx, token, chatId, parts[1] ?? "", messageThreadId, companyId);
      break;
    case "run":
      await runCommand(ctx, token, chatId, parts[1] ?? "", parts.slice(2), messageThreadId, companyId);
      break;
    default:
      await sendMessage(ctx, token, chatId, [
        escapeMarkdownV2("\ud83d\udee0\ufe0f") + " *Custom Commands*",
        "",
        `/commands list \\- ${escapeMarkdownV2("Show all custom commands")}`,
        `/commands import <json> \\- ${escapeMarkdownV2("Import a workflow command")}`,
        `/commands delete <name> \\- ${escapeMarkdownV2("Remove a custom command")}`,
        `/commands run <name> [args] \\- ${escapeMarkdownV2("Execute a custom command")}`,
      ].join("\n"), { parseMode: "MarkdownV2", messageThreadId });
  }
}

// Check if a command is custom and run it, returns true if handled
export async function tryCustomCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  command: string,
  argsStr: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<boolean> {
  if (BUILTIN_COMMANDS.has(command)) return false;

  // Unlinked chat: never fall back to chatId as a companyId. Returning false
  // lets the built-in command path answer with its "not linked" guidance.
  if (!companyId) return false;

  const commands = await getCommandRegistry(ctx, companyId);
  const cmd = commands.find((c) => c.name === command);

  if (!cmd) return false;

  const args = argsStr.trim().split(/\s+/).filter(Boolean);
  await executeWorkflow(ctx, token, chatId, cmd, args, messageThreadId, companyId);
  return true;
}

async function listCommands(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);

  if (commands.length === 0) {
    await sendMessage(ctx, token, chatId, "No custom commands registered. Use /commands import to add one.", { messageThreadId });
    return;
  }

  const lines = [
    escapeMarkdownV2("\ud83d\udee0\ufe0f") + " *Custom Commands*",
    "",
  ];

  for (const cmd of commands) {
    lines.push(`/${escapeMarkdownV2(cmd.name)} \\- ${escapeMarkdownV2(cmd.description)}`);
    lines.push(`  Steps: ${escapeMarkdownV2(String(cmd.steps.length))} \\| Created: ${escapeMarkdownV2(cmd.createdAt.split("T")[0] ?? cmd.createdAt)}`);
  }

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

async function importCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  jsonStr: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  if (!jsonStr.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /commands import <json-definition>", { messageThreadId });
    return;
  }

  let definition: { name: string; description: string; steps: WorkflowStep[] };
  try {
    definition = JSON.parse(jsonStr);
  } catch {
    await sendMessage(ctx, token, chatId, "Invalid JSON. Please provide a valid command definition.", { messageThreadId });
    return;
  }

  if (!definition.name || !definition.steps || !Array.isArray(definition.steps)) {
    await sendMessage(ctx, token, chatId, "Command definition must have 'name' and 'steps' fields.", { messageThreadId });
    return;
  }

  if (BUILTIN_COMMANDS.has(definition.name)) {
    await sendMessage(ctx, token, chatId, `Cannot override built-in command: /${definition.name}`, { messageThreadId });
    return;
  }

  // Validate steps
  for (const step of definition.steps) {
    if (!step.type || !step.id) {
      await sendMessage(ctx, token, chatId, "Each step must have 'type' and 'id' fields.", { messageThreadId });
      return;
    }
    const validTypes = ["fetch_issue", "invoke_agent", "http_request", "send_message", "create_issue", "wait_approval", "set_state"];
    if (!validTypes.includes(step.type)) {
      await sendMessage(ctx, token, chatId, `Invalid step type: ${step.type}. Valid: ${validTypes.join(", ")}`, { messageThreadId });
      return;
    }
  }

  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);

  // Replace existing or add new
  const existingIdx = commands.findIndex((c) => c.name === definition.name);
  const newCmd: CustomCommand = {
    name: definition.name,
    description: definition.description ?? "No description",
    steps: definition.steps,
    createdBy: `telegram:${chatId}`,
    createdAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    commands[existingIdx] = newCmd;
  } else {
    commands.push(newCmd);
  }

  await saveCommandRegistry(ctx, resolvedCompanyId, commands);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\u2705")} Command /${escapeMarkdownV2(definition.name)} ${existingIdx >= 0 ? "updated" : "imported"} \\(${escapeMarkdownV2(String(definition.steps.length))} steps\\)`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function deleteCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  name: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  if (!name.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /commands delete <name>", { messageThreadId });
    return;
  }

  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);
  const filtered = commands.filter((c) => c.name !== name);

  if (filtered.length === commands.length) {
    await sendMessage(ctx, token, chatId, `Command /${name} not found.`, { messageThreadId });
    return;
  }

  await saveCommandRegistry(ctx, resolvedCompanyId, filtered);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\ud83d\uddd1\ufe0f")} Command /${escapeMarkdownV2(name)} deleted.`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function runCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  name: string,
  args: string[],
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);
  const cmd = commands.find((c) => c.name === name);

  if (!cmd) {
    await sendMessage(ctx, token, chatId, `Command /${name} not found.`, { messageThreadId });
    return;
  }

  await executeWorkflow(ctx, token, chatId, cmd, args, messageThreadId, resolvedCompanyId);
}

// --- Workflow executor ---

async function executeWorkflow(
  ctx: PluginContext,
  token: string,
  chatId: string,
  cmd: CustomCommand,
  args: string[],
  messageThreadId: number | undefined,
  companyId: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);
  await ctx.metrics.write(METRIC_NAMES.commandsExecuted, 1);

  const results: StepResult[] = [];

  for (const step of cmd.steps) {
    try {
      const result = await executeStep(ctx, token, chatId, step, args, results, messageThreadId, companyId);
      results.push({ stepId: step.id, result: result ?? "" });
    } catch (err) {
      ctx.logger.error("Workflow step failed", { command: cmd.name, stepId: step.id, error: String(err) });
      await sendMessage(
        ctx,
        token,
        chatId,
        `Step "${step.name ?? step.id}" failed: ${String(err)}`,
        { messageThreadId },
      );
      return; // Stop execution on failure
    }
  }

  ctx.logger.info("Workflow completed", { command: cmd.name, steps: results.length });
}

// --- wait_approval callback resolution ---
//
// Mirrors the /decisions and interaction-answers.ts shape: `wait_approval`
// above only parks a pending record and returns, so this resolves it from a
// callback_query on a later update instead of anything the step itself awaits.

let approvalCounter = 0;
function nextApprovalId(): string {
  approvalCounter = (approvalCounter + 1) % 100000;
  return `${Date.now().toString(36)}${approvalCounter.toString(36)}`;
}

function approvalStateKey(approvalId: string) {
  return { scopeKind: "instance" as const, stateKey: `cmd_approval_${approvalId}` };
}

export function isWorkflowApprovalCallback(data: string): boolean {
  return data.startsWith("cmd_approve_") || data.startsWith("cmd_reject_");
}

/**
 * Record an approve/reject button press. Returns the decision so the caller
 * can answer the callback and edit the message, or null when there was
 * nothing pending — already decided, or a redelivered/expired callback.
 */
export async function resolveWorkflowApprovalCallback(
  ctx: PluginContext,
  data: string,
): Promise<"approved" | "rejected" | null> {
  if (!isWorkflowApprovalCallback(data)) return null;
  const decision = data.startsWith("cmd_approve_") ? "approved" : "rejected";
  const approvalId = data.slice(data.indexOf("_", 4) + 1);
  const key = approvalStateKey(approvalId);
  const existing = (await ctx.state.get(key)) as { status?: string } | null;
  if (!existing || existing.status !== "pending") return null;
  await ctx.state.set(key, { status: decision, decidedAt: Date.now() });
  return decision;
}

async function executeStep(
  ctx: PluginContext,
  token: string,
  chatId: string,
  step: WorkflowStep,
  args: string[],
  prevResults: StepResult[],
  messageThreadId: number | undefined,
  companyId: string,
): Promise<string | null> {
  const interpolate = (template: string): string => {
    let result = template;
    // Replace {{arg0}}, {{arg1}}, etc.
    for (let i = 0; i < args.length; i++) {
      result = result.replace(new RegExp(`\\{\\{arg${i}\\}\\}`, "g"), args[i]!);
    }
    result = result.replace(/\{\{args\}\}/g, args.join(" "));
    // Replace {{prev.result}}, {{step_id.result}}
    if (prevResults.length > 0) {
      const lastResult = prevResults[prevResults.length - 1]!;
      result = result.replace(/\{\{prev\.result\}\}/g, lastResult.result);
    }
    for (const prev of prevResults) {
      result = result.replace(new RegExp(`\\{\\{${prev.stepId}\\.result\\}\\}`, "g"), prev.result);
    }
    return result;
  };

  switch (step.type) {
    case "fetch_issue": {
      const issueId = interpolate(step.issueId);
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return JSON.stringify({ error: "Issue not found", issueId });
      return JSON.stringify({ id: issue.id, title: issue.title, status: issue.status });
    }

    case "invoke_agent": {
      const prompt = interpolate(step.prompt);
      const { runId } = await ctx.agents.invoke(step.agentId, companyId, {
        prompt,
        reason: `custom_command:${step.id}`,
      });
      return runId;
    }

    case "http_request": {
      const url = interpolate(step.url);
      const body = step.body ? interpolate(step.body) : undefined;
      const res = await ctx.http.fetch(url, {
        method: step.method,
        headers: step.headers ? Object.fromEntries(
          Object.entries(step.headers).map(([k, v]) => [k, interpolate(v)]),
        ) : undefined,
        body,
      });
      const data = await res.text();
      return data;
    }

    case "send_message": {
      const text = interpolate(step.text);
      await sendMessage(ctx, token, chatId, text, { messageThreadId });
      return "sent";
    }

    case "create_issue": {
      const title = interpolate(step.title);
      const description = step.description ? interpolate(step.description) : undefined;
      const issue = await ctx.issues.create({
        companyId,
        title,
        description,
        projectId: step.projectId,
        assigneeAgentId: step.assigneeAgentId,
      });
      if (step.assigneeAgentId) {
        await ctx.issues.update(issue.id, { status: "todo" }, companyId);
      }
      return issue.id;
    }

    case "wait_approval": {
      const prompt = interpolate(step.prompt);
      const approvalId = nextApprovalId();
      await sendMessage(ctx, token, chatId, prompt, {
        messageThreadId,
        inlineKeyboard: [
          [
            { text: "Approve", callback_data: `cmd_approve_${approvalId}` },
            { text: "Reject", callback_data: `cmd_reject_${approvalId}` },
          ],
        ],
      });
      // Park the decision in state and return immediately — nothing here
      // awaits the button press. worker.ts's callback handler resolves this
      // record from a later update (BLA-156); see resolveWorkflowApprovalCallback.
      await ctx.state.set(approvalStateKey(approvalId), { status: "pending", createdAt: Date.now() });
      return "awaiting_approval";
    }

    // NOTE: there is deliberately no "choice" step.
    //
    // A step that asks the user to pick and waits for the answer cannot work
    // here: updates are processed strictly sequentially, so a workflow that
    // blocks on a button press blocks the loop that would deliver it. The
    // press can never arrive and the run stalls until it times out. This is
    // the same defect that shipped and got reverted for /choose
    // (BLA-150/BLA-153); see interaction-answers.ts for the retrospective.
    //
    // `wait_approval`, above, follows the pattern that does work: it sends
    // the buttons and parks a pending record in state without awaiting
    // anything, so the loop stays free to deliver the button press as its
    // own later update. worker.ts's callback handler resolves that record.
    // What this does NOT do is pause the workflow: steps after
    // `wait_approval` already ran by the time a human can tap a button,
    // since the step returns "awaiting_approval" immediately instead of
    // blocking. Making later steps actually wait on the decision needs the
    // workflow engine to persist a continuation and resume it from a
    // callback, which does not exist yet — today `wait_approval` is only
    // meaningful as a workflow's last step.
    case "set_state": {
      const key = interpolate(step.key);
      const value = interpolate(step.value);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: key },
        value,
      );
      return value;
    }

    default:
      return null;
  }
}

// --- State helpers ---

async function getCommandRegistry(ctx: PluginContext, companyId: string): Promise<CustomCommand[]> {
  const commands = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `commands_${companyId}`,
  }) as CustomCommand[] | null;
  return commands ?? [];
}

async function saveCommandRegistry(ctx: PluginContext, companyId: string, commands: CustomCommand[]): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `commands_${companyId}` },
    commands,
  );
}
