#!/usr/bin/env node
/**
 * Mutation check: reintroduce known bugs and prove the suite goes red.
 *
 * Every defect this plugin has shipped failed SILENTLY — no throw, no error
 * log, a bot that looked connected and did nothing. Line coverage does not
 * catch that class of bug: a line runs during a test whether or not anything
 * asserts on what it did. `src/decisions.ts` sat at 100% statement coverage
 * while three of its behaviours had no assertion behind them, including two a
 * commit message claimed to have covered.
 *
 * So this is the check that coverage cannot make: break the code on purpose,
 * and fail if the tests still pass.
 *
 *   npm run test:mutations
 *   npm run test:mutations -- --filter=verbs   # one mutation, by id substring
 *   npm run test:mutations -- --list           # show the catalogue, run nothing
 *
 * Adding a mutation is the cheapest way to lock in a bug you just fixed:
 * describe the user-visible failure in `breaks`, and point `find`/`replace` at
 * the guard that prevents it.
 *
 * A mutation whose `find` anchor no longer matches is a HARD FAILURE, not a
 * skip. A silently-skipped mutation is the same false confidence this script
 * exists to remove — if you refactor the source, re-anchor the mutation.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @type {Array<{id: string, file: string, breaks: string, find: string, replace: string}>}
 * `breaks` states the user-visible consequence, so a MISSED result reads as a
 * product risk rather than a coverage statistic.
 */
const MUTATIONS = [
  {
    id: "confirmation-branch",
    file: "src/decisions.ts",
    breaks:
      "request_confirmation items stop being answerable — half of BLA-154 silently reverts to a web link.",
    find: `  if (fresh.kind === "request_confirmation") {
    return { id: fresh.id, kind: "request_confirmation", payload: fresh.payload as RequestConfirmationPayload };
  }`,
    replace: `  if (fresh.kind === "request_confirmation") {
    return null;
  }`,
  },
  {
    id: "stale-interaction",
    file: "src/decisions.ts",
    breaks:
      "An interaction answered in the web UI since the /attention snapshot is still offered as buttons; the answer is rejected and the user is told nothing.",
    find: '  if (!fresh || fresh.status !== "pending") return null;',
    replace: "  if (!fresh) return null;",
  },
  {
    id: "free-text-questions",
    file: "src/decisions.ts",
    breaks:
      "Questions with a designer-declared free-text option are rendered as buttons, so the answer the designer asked for cannot be given.",
    find: "    if (!isAskUserQuestionsAnswerable(payload)) return null;",
    replace: "    // guard removed",
  },
  {
    id: "inline-resolvable",
    file: "src/decisions.ts",
    breaks:
      "The host's inlineResolvable verdict is overridden and items it declined to expose inline are answered from Telegram anyway.",
    find: "    inlineResolvable: raw.inlineResolvable === true,",
    replace: "    inlineResolvable: true,",
  },
  {
    id: "decision-verbs",
    file: "src/decisions.ts",
    breaks:
      "The host's own decisionVerbs are dropped, so the Options line disappears and the bot is free to invent labels the host never offered.",
    find: `  const verbs = Array.isArray(raw.decisionVerbs)
    ? (raw.decisionVerbs as Array<Record<string, unknown>>)
        .map((v) => (typeof v.label === "string" ? v.label : ""))
        .filter(Boolean)
    : [];`,
    replace: "  const verbs: string[] = [];",
  },
  {
    id: "approval-inline-resolvable-ignored",
    file: "src/decisions.ts",
    breaks:
      "An approval the host marked inlineResolvable: false gets an Approve button anyway, offering an action the host explicitly declined to expose inline (BLA-622).",
    find: `    const approvable = item.sourceKind === "approval" && item.inlineResolvable && item.approvalId
      ? item.approvalId
      : null;`,
    replace: `    const approvable = item.sourceKind === "approval" && item.approvalId
      ? item.approvalId
      : null;`,
  },
  {
    id: "decisions-pagination-repeats-first-page",
    file: "src/decisions.ts",
    breaks:
      "Tapping 'Show more' resends the items already on screen instead of only the new ones, because the render offset is silently dropped (BLA-622).",
    find: "  for (const item of items.slice(offset, limit)) {",
    replace: "  for (const item of items.slice(0, limit)) {",
  },
  {
    id: "decisions-limit-uncapped",
    file: "src/decisions.ts",
    breaks:
      "A /decisions limit above the attention endpoint's documented 100-item cap is sent unclamped, which the live API is free to reject instead of silently truncating (BLA-622).",
    find: '  const query = limit ? `?limit=${Math.min(Math.max(1, Math.floor(limit)), MAX_ATTENTION_LIMIT)}` : "";',
    replace: '  const query = limit ? `?limit=${limit}` : "";',
  },
  {
    id: "decisions-more-offset-unvalidated",
    file: "src/decisions.ts",
    breaks:
      "A malformed dec_more_ callback (non-numeric or negative offset) is treated as valid instead of failing safely, producing a nonsensical fetch instead of the 'Could not load more' message (BLA-622).",
    find: "  if (!Number.isInteger(offset) || offset < 0) {",
    replace: "  if (false) {",
  },
  {
    id: "approval-gate-not-enforced",
    file: "src/command-registry.ts",
    breaks:
      "A workflow runs straight past its wait_approval gate, executing the very steps the approval exists to hold back. The Approve button becomes decorative.",
    find: '      if (typeof result === "string" && result.startsWith(AWAITING_APPROVAL_PREFIX)) {',
    replace: "      if (false) {",
  },
  {
    id: "approval-replayable",
    file: "src/command-registry.ts",
    breaks:
      "The parked continuation is not consumed, so pressing Approve twice runs the rest of the workflow twice.",
    find: '  await ctx.state.set({ scopeKind: "instance", stateKey }, { ...parked, resolved: true });',
    replace: "",
  },
  {
    id: "approval-reject-resumes",
    file: "src/command-registry.ts",
    breaks:
      "Rejecting a workflow resumes it anyway — the most dangerous possible reading of a Reject button.",
    find: "  if (!approved) {",
    replace: "  if (false) {",
  },
  {
    id: "callback-double-answer",
    file: "src/interaction-answers.ts",
    breaks:
      "A button press is submitted without re-checking the interaction is still pending, so a stale message answers something already resolved.",
    find: '  if (!fresh || fresh.status !== "pending") {',
    replace: "  if (false) {",
  },
  {
    id: "issue-done-dedupe",
    file: "src/worker.ts",
    breaks:
      "issue.updated(done) loses its dedupe guard, so the duplicate events Paperclip's core emits for one PATCH each send their own 'Issue Completed' message.",
    find: "        if (!doneDedupe(`done|${event.entityId}`)) return;",
    replace: "        // dedupe removed",
  },
  {
    id: "assignment-only-notify-filter",
    file: "src/worker.ts",
    breaks:
      "onlyNotifyIfAssignedTo stops filtering — every assignment change pages the configured chat regardless of who it was assigned to.",
    find: `        if (effectiveConfig.onlyNotifyIfAssignedTo && payload.assigneeUserId !== effectiveConfig.onlyNotifyIfAssignedTo) {
          return;
        }`,
    replace: "",
  },
  {
    id: "digest-slot-guard",
    file: "src/worker.ts",
    breaks:
      "The daily digest job fires on every scheduled tick instead of only at the configured time — a flood of digests instead of one a day.",
    find: "        if (!manualRun && !digestSlot) continue;",
    replace: "        // slot guard removed",
  },
  {
    id: "digest-resend-guard",
    file: "src/worker.ts",
    breaks:
      "The already-sent check for the digest's time slot is dropped, so a digest that fires once and one that fires on every tick within the same minute both look identical from outside — until the chat gets it twice.",
    find: "          if (alreadySent) continue;",
    replace: "          // resend guard removed",
  },
  {
    id: "escalation-timeouts-company-wiring",
    file: "src/worker.ts",
    breaks:
      "check-escalation-timeouts stops passing the startup company through to resolveCompanyRuntimes — the exact BLA-218 regression that made the job silently no-op while logging success.",
    find: `          (effectiveConfig) => Boolean(effectiveConfig.enableInbound || effectiveConfig.escalationChatId),
          undefined,
          startupConfigCompanyId,
        );`,
    replace: `          (effectiveConfig) => Boolean(effectiveConfig.enableInbound || effectiveConfig.escalationChatId),
          undefined,
          undefined,
        );`,
  },
  {
    id: "check-watches-company-wiring",
    file: "src/worker.ts",
    breaks:
      "check-watches stops passing the startup company through to resolveCompanyRuntimes — the same BLA-218 regression as check-escalation-timeouts, for proactive suggestions instead of escalations.",
    find: `          (effectiveConfig) => (effectiveConfig.maxSuggestionsPerHourPerCompany ?? 10) > 0,
          undefined,
          startupConfigCompanyId,
        );`,
    replace: `          (effectiveConfig) => (effectiveConfig.maxSuggestionsPerHourPerCompany ?? 10) > 0,
          undefined,
          undefined,
        );`,
  },
  {
    id: "setmycommands-dedupe",
    file: "src/worker.ts",
    breaks:
      "The per-token dedupe on bot-command registration is dropped, so a token shared by N companies calls Telegram's setMyCommands N times at startup instead of once — wasted calls that can trip Telegram's rate limit.",
    find: "      if (commandRegistrationRefs.has(runtime.config.telegramBotTokenRef)) continue;",
    replace: "      // dedupe removed",
  },
  {
    id: "chat-id-as-company-id",
    file: "src/acp-bridge.ts",
    breaks:
      "An unlinked chat resolves to its Telegram chat id used as a Paperclip company id — an address that cannot work, spent silently on every host call.",
    find: "  return mapping?.companyId ?? mapping?.companyName ?? null;",
    replace: "  return mapping?.companyId ?? mapping?.companyName ?? chatId;",
  },
  {
    id: "loop-company-not-threaded",
    file: "src/acp-bridge.ts",
    breaks:
      "The discussion loop stops using the host's own companyId from the event envelope and re-derives it from chat state, which is guesswork by comparison.",
    find:
      "  await checkConversationLoopContinuation(ctx, token, chatId, threadId, sessionId, text, done, companyId);",
    replace:
      "  await checkConversationLoopContinuation(ctx, token, chatId, threadId, sessionId, text, done);",
  },
  {
    id: "loop-unresolved-company",
    file: "src/acp-bridge.ts",
    breaks:
      "An agent-to-agent discussion continues with an unresolved company, re-spending the failure on every remaining turn instead of pausing once.",
    find: `      const resolvedCompanyId = companyId ?? await resolveCompanyIdFromChat(ctx, chatId);
      if (!resolvedCompanyId) {`,
    replace: `      const resolvedCompanyId = (companyId ?? await resolveCompanyIdFromChat(ctx, chatId)) as string;
      if (false) {`,
  },
  {
    id: "route-message-unlinked",
    file: "src/acp-bridge.ts",
    breaks:
      "A message addressed to a live agent session in an unlinked chat is routed to a fake company instead of telling the user to /connect.",
    find: `  if (!resolvedCompanyId) {
    // Handled: the message was addressed to a live session, so staying silent
    // here would look like the agent simply ignored it.
    await sendMessage(ctx, token, chatId, NOT_LINKED_MESSAGE, { parseMode: undefined, messageThreadId: threadId });
    return true;
  }`,
    replace: "",
  },
  {
    id: "escalation-resolved-emit-dropped",
    file: "src/escalation.ts",
    breaks:
      "A human answers an escalation and escalation.resolved fails to emit silently — the agent never hears the human answered (BLA-343).",
    find: `    await ctx.events.emit("escalation.resolved", stored.companyId, {
      escalationId: stored.escalationId,
      agentId: stored.agentId,
      responderId: response.responderId,
      responseText: response.responseText,
      action: response.action,
    }).catch((err: unknown) => {
      ctx.logger.error("Failed to emit escalation.resolved", {
        escalationId: stored.escalationId,
        companyId: stored.companyId,
        error: String(err),
      });
    });`,
    replace: `    ctx.events.emit("escalation.resolved", stored.companyId, {
      escalationId: stored.escalationId,
      agentId: stored.agentId,
      responderId: response.responderId,
      responseText: response.responseText,
      action: response.action,
    });`,
  },
  {
    id: "escalation-timed-out-emit-dropped",
    file: "src/escalation.ts",
    breaks:
      "An escalation times out and escalation.timed_out fails to emit silently — nothing downstream ever learns the default action fired (BLA-343).",
    find: `      await ctx.events.emit("escalation.timed_out", stored.companyId, {
        escalationId,
        agentId: stored.agentId,
        defaultAction: stored.defaultAction,
        suggestedReply: stored.suggestedReply,
      }).catch((err: unknown) => {
        ctx.logger.error("Failed to emit escalation.timed_out", {
          escalationId,
          companyId: stored.companyId,
          error: String(err),
        });
      });`,
    replace: `      ctx.events.emit("escalation.timed_out", stored.companyId, {
        escalationId,
        agentId: stored.agentId,
        defaultAction: stored.defaultAction,
        suggestedReply: stored.suggestedReply,
      });`,
  },
];

const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith("--filter="))?.slice("--filter=".length);
const selected = filter ? MUTATIONS.filter((m) => m.id.includes(filter)) : MUTATIONS;

if (args.includes("--list")) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(24)} ${m.file}\n${" ".repeat(25)}${m.breaks}`);
  process.exit(0);
}

if (selected.length === 0) {
  console.error(`No mutation matches --filter=${filter}. Use --list to see the catalogue.`);
  process.exit(1);
}

const abs = (f) => path.join(ROOT, f);

/** Refuse to run against edits we could lose if this crashes mid-mutation. */
function assertTargetsClean() {
  const files = [...new Set(selected.map((m) => m.file))];
  const res = spawnSync("git", ["status", "--porcelain", "--", ...files], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error("Could not read git status; refusing to mutate files in place.");
    process.exit(1);
  }
  if (res.stdout.trim()) {
    console.error(
      "Uncommitted changes in the files this script rewrites:\n" +
        res.stdout +
        "\nCommit or stash them first — a crash mid-run would restore over your edits.",
    );
    process.exit(1);
  }
}

function runSuite() {
  // --bail=1 because the only question is whether the suite goes red at all.
  const res = spawnSync("npx", ["vitest", "run", "--reporter=dot", "--bail=1"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return res.status !== 0;
}

assertTargetsClean();

/** Files rewritten right now, restored on any exit path including Ctrl-C. */
const open = new Map();
const restoreAll = () => {
  for (const [file, original] of open) writeFileSync(file, original);
  open.clear();
};
process.on("SIGINT", () => {
  restoreAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreAll();
  process.exit(143);
});

const results = [];
try {
  for (const m of selected) {
    const file = abs(m.file);
    const original = readFileSync(file, "utf8");

    if (!original.includes(m.find)) {
      results.push({ id: m.id, status: "STALE", note: `anchor not found in ${m.file}` });
      console.log(`STALE   ${m.id} — anchor not found in ${m.file}`);
      continue;
    }

    open.set(file, original);
    writeFileSync(file, original.replace(m.find, m.replace));
    try {
      const caught = runSuite();
      results.push({ id: m.id, status: caught ? "CAUGHT" : "MISSED", note: m.breaks });
      console.log(`${caught ? "CAUGHT " : "MISSED "} ${m.id}`);
    } finally {
      writeFileSync(file, original);
      open.delete(file);
    }
  }
} finally {
  restoreAll();
}

const bad = results.filter((r) => r.status !== "CAUGHT");
console.log("\n===== mutation check =====");
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id}`);
console.log(`\n${results.length - bad.length}/${results.length} mutations caught`);

const missed = bad.filter((r) => r.status === "MISSED");
const stale = bad.filter((r) => r.status === "STALE");

if (missed.length) {
  console.log("\nUnguarded behaviour — the code broke and the suite stayed green:");
  for (const r of missed) console.log(`  ${r.id}: ${r.note}`);
  console.log("\nAdd an assertion that fails for each mutation above.");
}

if (stale.length) {
  console.log("\nNot checked at all — the mutation no longer applies to the source:");
  for (const r of stale) console.log(`  ${r.id}: ${r.note}`);
  console.log("\nRe-anchor these against the refactored code; a skipped mutation proves nothing.");
}

process.exit(bad.length ? 1 : 0);
