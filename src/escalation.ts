import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, editMessage, escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import { wakeAgentWithIssue } from "./acp-bridge.js";
import { AGENT_ERROR_TRUNCATE_LENGTH, TRUNCATE_MEDIUM } from "./constants.js";
import { park, unpark, clear, listExpired, encodeCallback } from "./parked-interactions.js";

export type EscalationReason =
  | "low_confidence"
  | "explicit_request"
  | "policy_violation"
  | "unknown_intent";

export type EscalationEvent = {
  escalationId: string;
  agentId: string;
  companyId: string;
  reason: EscalationReason;
  context: {
    conversationHistory: Array<{ role: string; text: string }>;
    agentReasoning: string;
    suggestedActions: string[];
    suggestedReply?: string;
    confidenceScore?: number;
  };
  timeout: {
    durationMs: number;
    defaultAction: "defer" | "auto_reply" | "close";
  };
  originChatId?: string;
  originThreadId?: string;
  originMessageId?: string;
  // Transport info for routing replies back
  transport?: "native" | "acp";
  sessionId?: string;
};

export type EscalationResponse = {
  escalationId: string;
  responderId: string;
  responseText: string;
  action: "reply_to_customer" | "override_suggested" | "dismiss";
};

type StoredEscalation = {
  escalationId: string;
  agentId: string;
  companyId: string;
  reason: EscalationReason;
  agentReasoning: string;
  suggestedReply?: string;
  suggestedActions: string[];
  confidenceScore?: number;
  originChatId?: string;
  originThreadId?: string;
  originMessageId?: string;
  escalationChatId: string;
  escalationMessageId: string;
  // No `status` field: liveness is "the park exists" (parked-interactions.ts
  // owns that rule). Resolving or timing out clears the row instead of
  // flipping a sentinel next to a row that sits in `plugin_state` forever.
  defaultAction: "defer" | "auto_reply" | "close";
  transport?: "native" | "acp";
  sessionId?: string;
};

const REASON_LABELS: Record<EscalationReason, string> = {
  low_confidence: "Low Confidence",
  explicit_request: "User Requested Human",
  policy_violation: "Policy Violation",
  unknown_intent: "Unknown Intent",
};

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

export class EscalationManager {
  async create(
    ctx: PluginContext,
    token: string,
    event: EscalationEvent,
    escalationChatId: string,
  ): Promise<void> {
    const reasonLabel = REASON_LABELS[event.reason] ?? event.reason;
    const confidence = event.context.confidenceScore != null
      ? ` \\(${esc(String(Math.round(event.context.confidenceScore * 100)))}%\\)`
      : "";

    const lines: string[] = [
      `${esc("\u26a0\ufe0f")} *Escalation* \\- ${esc(reasonLabel)}${confidence}`,
      "",
      `*Agent:* ${esc(event.agentId)}`,
      `*Reason:* ${esc(event.context.agentReasoning ? truncateAtWord(event.context.agentReasoning, AGENT_ERROR_TRUNCATE_LENGTH) : "No details provided")}`,
    ];

    if (event.context.suggestedActions.length > 0) {
      lines.push("");
      lines.push("*Suggested actions:*");
      for (const action of event.context.suggestedActions.slice(0, 5)) {
        lines.push(`  ${esc("-")} ${esc(action)}`);
      }
    }

    if (event.context.suggestedReply) {
      lines.push("");
      lines.push("*Suggested reply:*");
      lines.push(`${esc(">")} ${esc(truncateAtWord(event.context.suggestedReply, TRUNCATE_MEDIUM))}`);
    }

    lines.push("");
    lines.push(`ID: \`${esc(event.escalationId)}\``);

    // event.escalationId is minted by the tool call (crypto.randomUUID())
    // and must stay reachable both from these buttons and from the separate
    // reply-to-message mapping below, so it is used as the park's key rather
    // than letting parked-interactions.ts allocate one.
    const buttons = [];
    if (event.context.suggestedReply) {
      buttons.push([
        { text: "Send Suggested Reply", callback_data: encodeCallback("esc", event.escalationId, "suggested") },
      ]);
    }
    buttons.push([
      { text: "Reply", callback_data: encodeCallback("esc", event.escalationId, "reply") },
      { text: "Override", callback_data: encodeCallback("esc", event.escalationId, "override") },
      { text: "Dismiss", callback_data: encodeCallback("esc", event.escalationId, "dismiss") },
    ]);

    const messageId = await sendMessage(ctx, token, escalationChatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      inlineKeyboard: buttons,
    });

    if (!messageId) {
      ctx.logger.error("Failed to send escalation message", { escalationId: event.escalationId });
      return;
    }

    const stored: StoredEscalation = {
      escalationId: event.escalationId,
      agentId: event.agentId,
      companyId: event.companyId,
      reason: event.reason,
      agentReasoning: event.context.agentReasoning,
      suggestedReply: event.context.suggestedReply,
      suggestedActions: event.context.suggestedActions,
      confidenceScore: event.context.confidenceScore,
      originChatId: event.originChatId,
      originThreadId: event.originThreadId,
      originMessageId: event.originMessageId,
      escalationChatId,
      escalationMessageId: String(messageId),
      defaultAction: event.timeout.defaultAction,
      transport: event.transport,
      sessionId: event.sessionId,
    };

    await park(ctx, "esc", stored, { key: event.escalationId, ttlMs: event.timeout.durationMs });

    // Map the escalation message back so replies can be routed
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `msg_${escalationChatId}_${messageId}` },
      {
        entityId: event.escalationId,
        entityType: "escalation",
        companyId: event.companyId,
        eventType: "escalation.created",
      },
    );

    ctx.logger.info("Escalation created", {
      escalationId: event.escalationId,
      reason: event.reason,
      timeoutAt: new Date(Date.now() + event.timeout.durationMs).toISOString(),
    });
  }

  async handleCallback(
    ctx: PluginContext,
    token: string,
    action: string,
    escalationId: string,
    actor: string,
    callbackQueryId: string,
    chatId: string | null,
    messageId: number | undefined,
  ): Promise<void> {
    const result = await unpark<StoredEscalation>(ctx, "esc", escalationId);
    if (result.status !== "live") {
      return;
    }
    const stored = result.payload;

    switch (action) {
      case "suggested": {
        if (!stored.suggestedReply) break;
        await this.resolve(ctx, token, stored, {
          escalationId,
          responderId: `telegram:${actor}`,
          responseText: stored.suggestedReply,
          action: "reply_to_customer",
        });
        break;
      }
      case "reply": {
        if (chatId && messageId) {
          await editMessage(
            ctx,
            token,
            chatId,
            messageId,
            `${esc("\u26a0\ufe0f")} *Escalation* \\- *Awaiting Your Reply*\n\n${esc("Reply to this message with your response to the customer.")}`,
            { parseMode: "MarkdownV2" },
          );
        }
        break;
      }
      case "dismiss": {
        await this.resolve(ctx, token, stored, {
          escalationId,
          responderId: `telegram:${actor}`,
          responseText: "",
          action: "dismiss",
        });
        break;
      }
      case "override": {
        if (chatId && messageId) {
          await editMessage(
            ctx,
            token,
            chatId,
            messageId,
            `${esc("\u26a0\ufe0f")} *Escalation* \\- *Override Mode*\n\n${esc("Reply to this message with your custom response.")}`,
            { parseMode: "MarkdownV2" },
          );
        }
        break;
      }
    }
  }

  async respond(
    ctx: PluginContext,
    token: string,
    escalationId: string,
    response: EscalationResponse,
  ): Promise<void> {
    const result = await unpark<StoredEscalation>(ctx, "esc", escalationId);
    if (result.status !== "live") {
      ctx.logger.warn("Escalation respond called for non-pending escalation", { escalationId });
      return;
    }

    await this.resolve(ctx, token, result.payload, response);
  }

  private async resolve(
    ctx: PluginContext,
    token: string,
    stored: StoredEscalation,
    response: EscalationResponse,
  ): Promise<void> {
    await clear(ctx, "esc", stored.escalationId);

    const statusLabel = response.action === "dismiss" ? "Dismissed" : "Resolved";
    await editMessage(
      ctx,
      token,
      stored.escalationChatId,
      Number(stored.escalationMessageId),
      `${esc("\u2705")} *Escalation ${statusLabel}* by ${esc(response.responderId)}\n\nID: \`${esc(stored.escalationId)}\``,
      { parseMode: "MarkdownV2" },
    );

    // Route reply back via the correct transport
    if (response.action === "reply_to_customer" && response.responseText) {
      if (stored.transport === "native" && stored.agentId) {
        await wakeAgentWithIssue(
          ctx,
          stored.agentId,
          stored.companyId,
          `[Human escalation response] ${response.responseText}`,
          "escalation_reply",
        );
      } else if (stored.transport === "acp" && stored.sessionId) {
        // Route back via ACP event. `events.emit` is a host RPC — a
        // rejection must not propagate: this runs inside handleUpdate's
        // call graph, and an uncaught throw there wedges Telegram polling
        // for every chat (see worker.ts's handleUpdate offset guard).
        await ctx.events.emit("acp-spawn", stored.companyId, {
          type: "message",
          sessionId: stored.sessionId,
          text: `[Human escalation response] ${response.responseText}`,
        }).catch((err: unknown) => {
          ctx.logger.error("Failed to emit acp-spawn for escalation reply", {
            escalationId: stored.escalationId,
            sessionId: stored.sessionId,
            error: String(err),
          });
        });
      }

      // Also send to the originating Telegram chat if available
      if (stored.originChatId) {
        await sendMessage(ctx, token, stored.originChatId, esc(response.responseText), {
          parseMode: "MarkdownV2",
          messageThreadId: stored.originThreadId ? Number(stored.originThreadId) : undefined,
          replyToMessageId: stored.originMessageId ? Number(stored.originMessageId) : undefined,
        });
      }
    }

    // Emit resolution event - companyId is SECOND arg. `events.emit` is a
    // host RPC — a rejection must not propagate silently: a human answered
    // this escalation and the agent needs to hear about it, so a dropped
    // emit is logged loudly rather than swallowed.
    await ctx.events.emit("escalation.resolved", stored.companyId, {
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
    });

    ctx.logger.info("Escalation resolved", {
      escalationId: stored.escalationId,
      action: response.action,
      responderId: response.responderId,
    });
  }

  /**
   * `now` defaults to the wall clock but should be the job's `scheduledAt`
   * (see `check-escalation-timeouts` in worker.ts) so timeout decisions run
   * against a controlled clock instead of real time.
   */
  async checkTimeouts(ctx: PluginContext, token: string, companyId?: string, now: number = Date.now()): Promise<void> {
    const expired = await listExpired<StoredEscalation>(ctx, "esc", now);

    for (const { key: escalationId, payload: stored } of expired) {
      // Leave a filtered-out company's park alone — it is still expired and
      // will be picked up by a check that isn't scoped away from it (a bare
      // call from the job, or that company's own next tick).
      if (companyId && stored.companyId !== companyId) continue;

      ctx.logger.info("Escalation timed out", { escalationId, defaultAction: stored.defaultAction });

      await clear(ctx, "esc", escalationId);

      await editMessage(
        ctx,
        token,
        stored.escalationChatId,
        Number(stored.escalationMessageId),
        `${esc("\u23f0")} *Escalation Timed Out*\n\nDefault action: ${esc(stored.defaultAction)}\nID: \`${esc(escalationId)}\``,
        { parseMode: "MarkdownV2" },
      );

      // Emit timeout event - companyId is SECOND arg. `events.emit` is a
      // host RPC — a rejection must not propagate: this runs inside the
      // check-escalation-timeouts job loop, and an uncaught throw here
      // would abort the remaining companies' timeout checks for this tick.
      await ctx.events.emit("escalation.timed_out", stored.companyId, {
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
      });

      if (stored.defaultAction === "auto_reply" && stored.suggestedReply && stored.originChatId) {
        await sendMessage(ctx, token, stored.originChatId, esc(stored.suggestedReply), {
          parseMode: "MarkdownV2",
          messageThreadId: stored.originThreadId ? Number(stored.originThreadId) : undefined,
          replyToMessageId: stored.originMessageId ? Number(stored.originMessageId) : undefined,
        });
      }
    }
  }
}
