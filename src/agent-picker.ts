import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Stateless agent picker for /choose.
 *
 * The obvious design — send buttons, await the answer, continue — DEADLOCKS.
 * Updates are processed strictly sequentially (`for (const update of updates)
 * { await handleUpdate(update) }`), so a handler that waits for a button press
 * blocks the very loop that would deliver it. The bot goes silent until the
 * wait times out, and the answer never arrives at all.
 *
 * So nothing is awaited. The pending pick is written to plugin state, the
 * buttons carry a short key, and the callback handler finishes the job on a
 * later update. This also means a pick survives a plugin restart, which the
 * in-memory approach could not.
 */

const CALLBACK_PREFIX = "chs_";
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export type PendingPick = {
  chatId: string;
  title: string;
  agentIds: string[];
  messageThreadId?: number;
  createdAt: number;
};

/** Short, collision-resistant enough for a per-chat pending pick. */
export function newPickKey(seed: number): string {
  return seed.toString(36).slice(-8);
}

export function isAgentPickCallback(data: string): boolean {
  return data.startsWith(CALLBACK_PREFIX);
}

export function buildAgentPickCallback(pickKey: string, agentIndex: number): string {
  return `${CALLBACK_PREFIX}${pickKey}_${agentIndex}`;
}

export function parseAgentPickCallback(data: string): { pickKey: string; agentIndex: number } | null {
  if (!isAgentPickCallback(data)) return null;
  const body = data.slice(CALLBACK_PREFIX.length);
  const separator = body.lastIndexOf("_");
  if (separator <= 0) return null;
  const pickKey = body.slice(0, separator);
  const agentIndex = Number(body.slice(separator + 1));
  if (!pickKey || !Number.isInteger(agentIndex) || agentIndex < 0) return null;
  return { pickKey, agentIndex };
}

function stateScope(companyId: string, pickKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey: `pick_${pickKey}` };
}

export async function savePendingPick(
  ctx: PluginContext,
  companyId: string,
  pickKey: string,
  pending: PendingPick,
): Promise<void> {
  await ctx.state.set(stateScope(companyId, pickKey), pending);
}

/**
 * Load and clear a pending pick. Cleared on read so a double-tap cannot create
 * the task twice — Telegram will happily deliver the same callback again.
 */
export async function takePendingPick(
  ctx: PluginContext,
  companyId: string,
  pickKey: string,
): Promise<PendingPick | null> {
  const raw = (await ctx.state.get(stateScope(companyId, pickKey))) as PendingPick | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.agentIds)) return null;
  await ctx.state.set(stateScope(companyId, pickKey), null);
  if (typeof raw.createdAt === "number" && Date.now() - raw.createdAt > PENDING_TTL_MS) return null;
  return raw;
}
