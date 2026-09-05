import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Single owner of key allocation, callback_data encode/decode, liveness, and
 * expiry for every Telegram flow that parks state between sending a message
 * and reacting to a later button press.
 *
 * Telegram delivers updates strictly sequentially — `for (const update of
 * updates) { await handleUpdate(update) }` in worker.ts — so a handler can
 * never await a button press without deadlocking the poll loop. Every
 * interactive flow therefore sends a message, parks what it needs to resume,
 * and returns; a LATER update (the callback_query) drives the resume. Before
 * this module each flow reinvented that park/resume shape independently: six
 * callback_data formats, three parsing idioms (`lastIndexOf`, `slice`,
 * `split`+`join`, `replace`), three liveness sentinels (row absent,
 * `resolved: true`, upstream `status`), and only one flow (ask_user_questions,
 * via `ctx.state.delete`) ever reclaimed its row. `wait_approval` is the worst
 * case upstream #103 describes: no expiry, no cleanup job, `plugin_state`
 * grows monotonically, and an unanswered gate hangs its workflow silently
 * forever.
 *
 * This module fixes that with one shape: `park()` writes a JSON envelope
 * carrying `expiresAt`; `unpark()` reads it and reports `expired` once that
 * passes; `clear()` always calls `ctx.state.delete` (never writes `null` —
 * that hits a NOT NULL constraint on `plugin_state.value_json` at the
 * platform layer and throws before either Telegram call in the caller ever
 * runs); `sweepExpired()` walks a per-flow index of live keys so
 * an abandoned park provably expires even if its callback is never tapped.
 */

const CALLBACK_PREFIX = "pk";
const SEPARATOR = ":";
const STATE_NAMESPACE = "parked-interactions";

/** One short tag per flow that parks state. Also the callback_data segment. */
export type ParkedFlow = "ask" | "conf" | "wapp" | "esc" | "ho";

export const PARKED_FLOWS: readonly ParkedFlow[] = ["ask", "conf", "wapp", "esc", "ho"];

/**
 * The flows the generic sweeper may delete blind.
 *
 * `esc` is deliberately absent. An expired escalation is not simply dead: its
 * `defaultAction` (defer / auto_reply / close) still has to be applied and the
 * chat told, which is `checkTimeouts`'s job and needs a Telegram call. The
 * sweeper makes no Telegram call by design -- that is why it does not wait on
 * `ensureRuntime()` -- so sweeping `esc` here would delete the park without
 * ever taking its action, and would do it precisely when the runtime is down
 * and `checkTimeouts` is no-opping. Every other parked flow expires to nothing.
 */
export const SWEEPABLE_FLOWS: readonly ParkedFlow[] = ["ask", "conf", "wapp", "ho"];

/**
 * Two flows (the approval-notice buttons formatters.ts/decisions.ts send,
 * and the decisions-paging "Show more" button) call a platform API directly
 * by an id the platform already owns — they never park local state, so they
 * have no liveness or TTL to track. They still use this module's codec: one
 * parsing idiom for every callback_data this plugin emits, not five.
 */
export type StatelessTag = "apr" | "dm";

export type CallbackTag = ParkedFlow | StatelessTag;

const KNOWN_TAGS: ReadonlySet<string> = new Set<CallbackTag>(["ask", "conf", "wapp", "esc", "ho", "apr", "dm"]);

/**
 * Default time a park survives without an explicit `ttlMs`. Long enough that
 * a human mid-conversation doesn't get expired out from under a real reply,
 * short enough that an abandoned park doesn't sit in `plugin_state` forever.
 * Callers with their own domain-appropriate window (escalation's configured
 * `escalationTimeoutMs`) pass `ttlMs` explicitly instead.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type Envelope<T> = {
  payload: T;
  createdAt: number;
  expiresAt: number;
};

let counter = 0;
/** Short, unique, separator-free — safe to embed in callback_data. */
function nextKey(): string {
  counter = (counter + 1) % 100000;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

function rowScopeKey(flow: ParkedFlow, key: string) {
  return { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey: `${flow}_${key}` };
}

function indexScopeKey(flow: ParkedFlow) {
  return { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey: `index_${flow}` };
}

async function readIndex(ctx: PluginContext, flow: ParkedFlow): Promise<string[]> {
  return ((await ctx.state.get(indexScopeKey(flow))) as string[] | null) ?? [];
}

async function addToIndex(ctx: PluginContext, flow: ParkedFlow, key: string): Promise<void> {
  const keys = await readIndex(ctx, flow);
  if (keys.includes(key)) return;
  keys.push(key);
  await ctx.state.set(indexScopeKey(flow), keys);
}

async function removeFromIndex(ctx: PluginContext, flow: ParkedFlow, key: string): Promise<void> {
  const keys = await readIndex(ctx, flow);
  const next = keys.filter((k) => k !== key);
  if (next.length === keys.length) return;
  await ctx.state.set(indexScopeKey(flow), next);
}

// --- Codec ---

export function encodeCallback(tag: CallbackTag, key: string, action: string): string {
  return [CALLBACK_PREFIX, tag, key, action].join(SEPARATOR);
}

export type DecodedCallback = { flow: CallbackTag; key: string; action: string };

export function isParkedCallback(data: string): boolean {
  return data.startsWith(`${CALLBACK_PREFIX}${SEPARATOR}`);
}

/**
 * The one parsing idiom for every callback_data this plugin emits: split on
 * `:`. Action itself may not contain `:` (none of the current flows' actions
 * do — plain tokens like `accept`, `o3`, `approve`); everything after the
 * third segment is rejoined so a future action that legitimately needs one
 * still decodes.
 */
export function decodeCallback(data: string): DecodedCallback | null {
  if (!isParkedCallback(data)) return null;
  const parts = data.split(SEPARATOR);
  if (parts.length < 4) return null;
  const [, flow, key, ...actionParts] = parts;
  if (!KNOWN_TAGS.has(flow) || !key) return null;
  const action = actionParts.join(SEPARATOR);
  if (!action) return null;
  return { flow: flow as CallbackTag, key, action };
}

// --- Park / unpark / clear ---

export async function park<T>(
  ctx: PluginContext,
  flow: ParkedFlow,
  payload: T,
  // `key`: use a caller-supplied id instead of allocating one. Escalation
  // needs this — its id is minted up front by the tool call (`crypto.randomUUID()`)
  // and has to stay reachable both from the callback buttons and from a
  // separate reply-to-message mapping keyed the same way, so the park has to
  // live under that id rather than one this module invents.
  opts?: { ttlMs?: number; key?: string },
): Promise<string> {
  const key = opts?.key ?? nextKey();
  const now = Date.now();
  const envelope: Envelope<T> = { payload, createdAt: now, expiresAt: now + (opts?.ttlMs ?? DEFAULT_TTL_MS) };
  await ctx.state.set(rowScopeKey(flow, key), envelope);
  await addToIndex(ctx, flow, key);
  return key;
}

/**
 * Overwrite a park's payload in place — e.g. toggling a multi-select option,
 * or advancing to the next question in an ask_user_questions flow — without
 * granting a fresh TTL each time a button is tapped. Falls back to a fresh
 * envelope if the original expired or was never there, so a caller does not
 * need to special-case a race against the sweeper.
 */
export async function reparkPayload<T>(ctx: PluginContext, flow: ParkedFlow, key: string, payload: T): Promise<void> {
  const existing = (await ctx.state.get(rowScopeKey(flow, key))) as Envelope<T> | null;
  const now = Date.now();
  const envelope: Envelope<T> = existing
    ? { ...existing, payload }
    : { payload, createdAt: now, expiresAt: now + DEFAULT_TTL_MS };
  await ctx.state.set(rowScopeKey(flow, key), envelope);
  await addToIndex(ctx, flow, key);
}

export type UnparkResult<T> =
  | { status: "live"; payload: T }
  | { status: "expired" }
  | { status: "not_found" };

/**
 * Read a park, applying liveness. Deletes and reports `expired` in the same
 * call, so a caller never re-reads a row it has already decided is dead.
 *
 * `now` defaults to the wall clock, which is correct for the common case —
 * resolving a live Telegram callback against the moment it actually arrived.
 * A caller evaluating liveness on behalf of a scheduled job should pass that
 * job's own `scheduledAt` instead (see `listExpired`, used by
 * `checkTimeouts` and the sweeper, for why).
 */
export async function unpark<T>(ctx: PluginContext, flow: ParkedFlow, key: string, now: number = Date.now()): Promise<UnparkResult<T>> {
  const envelope = (await ctx.state.get(rowScopeKey(flow, key))) as Envelope<T> | null;
  if (!envelope) return { status: "not_found" };
  if (now >= envelope.expiresAt) {
    await clear(ctx, flow, key);
    return { status: "expired" };
  }
  return { status: "live", payload: envelope.payload };
}

export async function clear(ctx: PluginContext, flow: ParkedFlow, key: string): Promise<void> {
  await ctx.state.delete(rowScopeKey(flow, key));
  await removeFromIndex(ctx, flow, key);
}

// --- Sweeper ---

export type ExpiredEntry<T> = { key: string; payload: T };

/**
 * List every park past its `expiresAt` for one flow, without deleting them.
 * For flows whose expiry has its own side effects (escalation's `defer` /
 * `auto_reply` / `close` default action) the caller needs the payload to act
 * on before the row is gone — it calls `clear()` itself once it has. A stale
 * index entry whose row is already gone (e.g. resolved through a path that
 * forgot to clean the index) is dropped from the index here rather than
 * reported as expired.
 *
 * Called from scheduled jobs (`checkTimeouts`, the sweeper) — `now` should
 * be that job's own `scheduledAt`, not the wall clock, so expiry decisions
 * run against a controlled clock instead of real time.
 */
export async function listExpired<T>(ctx: PluginContext, flow: ParkedFlow, now: number = Date.now()): Promise<ExpiredEntry<T>[]> {
  const keys = await readIndex(ctx, flow);
  const result: ExpiredEntry<T>[] = [];
  for (const key of keys) {
    const envelope = (await ctx.state.get(rowScopeKey(flow, key))) as Envelope<T> | null;
    if (!envelope) {
      await removeFromIndex(ctx, flow, key);
      continue;
    }
    if (now >= envelope.expiresAt) result.push({ key, payload: envelope.payload });
  }
  return result;
}

/** Delete every expired park for one flow. Returns how many were swept. */
export async function sweepExpiredFlow(ctx: PluginContext, flow: ParkedFlow, now: number = Date.now()): Promise<number> {
  const expired = await listExpired<unknown>(ctx, flow, now);
  for (const { key } of expired) {
    await clear(ctx, flow, key);
  }
  return expired.length;
}

/**
 * Delete every expired park across the flows that expire to nothing. The job
 * registered as `sweep-parked-interactions` calls this. Escalation is excluded
 * on purpose -- see SWEEPABLE_FLOWS.
 */
export async function sweepAllExpired(ctx: PluginContext, now: number = Date.now()): Promise<Partial<Record<ParkedFlow, number>>> {
  const result: Partial<Record<ParkedFlow, number>> = {};
  for (const flow of SWEEPABLE_FLOWS) {
    result[flow] = await sweepExpiredFlow(ctx, flow, now);
  }
  return result;
}
