import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  park,
  unpark,
  clear,
  reparkPayload,
  sweepExpiredFlow,
  sweepAllExpired,
  listExpired,
  encodeCallback,
  decodeCallback,
  isParkedCallback,
  PARKED_FLOWS,
} from "../src/parked-interactions.js";

let stateStore: Record<string, unknown> = {};

function mockCtx(): PluginContext {
  return {
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
      delete: vi.fn(async (key: { stateKey: string }) => {
        delete stateStore[key.stateKey];
      }),
    },
  } as unknown as PluginContext;
}

beforeEach(() => {
  stateStore = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe("codec: encodeCallback / decodeCallback", () => {
  it("round-trips flow, key, and action through the one parsing idiom (split on ':')", () => {
    const data = encodeCallback("wapp", "abc123", "approve");
    expect(data).toBe("pk:wapp:abc123:approve");
    expect(decodeCallback(data)).toEqual({ flow: "wapp", key: "abc123", action: "approve" });
  });

  it("recognizes every parked flow and the two stateless tags", () => {
    for (const flow of [...PARKED_FLOWS, "apr", "dm"] as const) {
      const data = encodeCallback(flow, "k", "a");
      expect(decodeCallback(data)).toEqual({ flow, key: "k", action: "a" });
    }
  });

  it("rejects data with an unknown flow tag", () => {
    expect(decodeCallback("pk:bogus:k:a")).toBeNull();
  });

  it("rejects data with too few segments", () => {
    expect(decodeCallback("pk:wapp:k")).toBeNull();
  });

  it("rejects data with an empty key or action", () => {
    expect(decodeCallback("pk:wapp::approve")).toBeNull();
    expect(decodeCallback("pk:wapp:k:")).toBeNull();
  });

  it("rejects data with no pk: prefix at all — the plugin's other callback formats (none currently exist) would not collide", () => {
    expect(isParkedCallback("something_else")).toBe(false);
    expect(decodeCallback("something_else")).toBeNull();
  });

  it("rejoins everything after the third segment, so an action containing ':' still decodes", () => {
    const decoded = decodeCallback("pk:wapp:k:a:b");
    expect(decoded).toEqual({ flow: "wapp", key: "k", action: "a:b" });
  });
});

describe("park / unpark / clear", () => {
  it("stores a JSON-serializable payload and returns it live before expiry", async () => {
    const ctx = mockCtx();
    const key = await park(ctx, "wapp", { hello: "world" });

    const result = await unpark<{ hello: string }>(ctx, "wapp", key);
    expect(result).toEqual({ status: "live", payload: { hello: "world" } });
  });

  it("reports not_found for a key that was never parked", async () => {
    const ctx = mockCtx();
    const result = await unpark(ctx, "wapp", "never-existed");
    expect(result).toEqual({ status: "not_found" });
  });

  it("allocates a distinct key per call, even within the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();

    const a = await park(ctx, "wapp", { n: 1 });
    const b = await park(ctx, "wapp", { n: 2 });

    expect(a).not.toBe(b);
  });

  it("honors a caller-supplied key instead of allocating one (escalation's stable id)", async () => {
    const ctx = mockCtx();
    const key = await park(ctx, "esc", { x: 1 }, { key: "esc-001" });
    expect(key).toBe("esc-001");
    expect((await unpark(ctx, "esc", "esc-001")).status).toBe("live");
  });

  it("clear() deletes the row via ctx.state.delete, never a null write", async () => {
    const ctx = mockCtx();
    const key = await park(ctx, "wapp", { a: 1 });

    await clear(ctx, "wapp", key);

    expect(stateStore[`wapp_${key}`]).toBeUndefined();
    expect(ctx.state.delete).toHaveBeenCalled();
    // Every ctx.state.set call in this flow wrote a real value, never `null`.
    for (const call of (ctx.state.set as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).not.toBeNull();
    }
  });

  it("clear() is idempotent — clearing twice does not throw", async () => {
    const ctx = mockCtx();
    const key = await park(ctx, "wapp", { a: 1 });
    await clear(ctx, "wapp", key);
    await expect(clear(ctx, "wapp", key)).resolves.toBeUndefined();
  });

  it("a second tap after clear() reports not_found, identical to an unknown key", async () => {
    const ctx = mockCtx();
    const key = await park(ctx, "wapp", { a: 1 });
    await clear(ctx, "wapp", key);

    expect(await unpark(ctx, "wapp", key)).toEqual({ status: "not_found" });
  });
});

describe("expiry (TTL)", () => {
  it("unpark() reports expired once past expiresAt, and clears the row as a side effect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();
    const key = await park(ctx, "wapp", { a: 1 }, { ttlMs: 1000 });

    vi.setSystemTime(2000);
    const result = await unpark(ctx, "wapp", key);

    expect(result).toEqual({ status: "expired" });
    expect(stateStore[`wapp_${key}`]).toBeUndefined();
  });

  it("stays live right up to the boundary, and expires exactly at it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();
    const key = await park(ctx, "wapp", { a: 1 }, { ttlMs: 1000 });

    vi.setSystemTime(999);
    expect((await unpark(ctx, "wapp", key)).status).toBe("live");

    vi.setSystemTime(1000);
    expect((await unpark(ctx, "wapp", key)).status).toBe("expired");
  });

  it("defaults to a 24h TTL when the caller does not specify one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();
    const key = await park(ctx, "ask", { a: 1 });

    vi.setSystemTime(23 * 60 * 60 * 1000);
    expect((await unpark(ctx, "ask", key)).status).toBe("live");

    vi.setSystemTime(25 * 60 * 60 * 1000);
    expect((await unpark(ctx, "ask", key)).status).toBe("expired");
  });
});

describe("reparkPayload", () => {
  it("overwrites the payload while preserving the original expiresAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();
    const key = await park(ctx, "ask", { step: 1 }, { ttlMs: 1000 });

    vi.setSystemTime(500);
    await reparkPayload(ctx, "ask", key, { step: 2 });

    // Still governed by the original 1000ms TTL, not a fresh one from the reparkPayload call.
    vi.setSystemTime(999);
    expect(await unpark(ctx, "ask", key)).toEqual({ status: "live", payload: { step: 2 } });
    vi.setSystemTime(1000);
    expect((await unpark(ctx, "ask", key)).status).toBe("expired");
  });

  it("falls back to a fresh envelope if the original was never parked", async () => {
    const ctx = mockCtx();
    await reparkPayload(ctx, "ask", "fresh-key", { step: 1 });

    expect(await unpark(ctx, "ask", "fresh-key")).toEqual({ status: "live", payload: { step: 1 } });
  });
});

describe("sweeper", () => {
  it("listExpired reports expired parks without deleting them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();
    const key = await park(ctx, "esc", { id: "e1" }, { ttlMs: 1000 });

    vi.setSystemTime(2000);
    const expired = await listExpired(ctx, "esc");

    expect(expired).toEqual([{ key, payload: { id: "e1" } }]);
    // Not cleared — listExpired is read-only so a caller with side effects
    // (escalation's default-action handling) can act before clearing.
    expect(stateStore[`esc_${key}`]).toBeDefined();
  });

  it("sweepExpiredFlow deletes every expired park for one flow and leaves live ones alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();
    const dead = await park(ctx, "wapp", { n: 1 }, { ttlMs: 1000 });
    const alive = await park(ctx, "wapp", { n: 2 }, { ttlMs: 10_000 });

    vi.setSystemTime(2000);
    const swept = await sweepExpiredFlow(ctx, "wapp");

    expect(swept).toBe(1);
    expect(stateStore[`wapp_${dead}`]).toBeUndefined();
    expect(stateStore[`wapp_${alive}`]).toBeDefined();
    expect((await unpark(ctx, "wapp", alive)).status).toBe("live");
  });

  it("sweepAllExpired covers every parked flow independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ctx = mockCtx();
    await park(ctx, "wapp", { n: 1 }, { ttlMs: 1000 });
    await park(ctx, "esc", { n: 1 }, { ttlMs: 1000 });
    await park(ctx, "ho", { n: 1 }, { ttlMs: 10_000 }); // stays alive

    vi.setSystemTime(2000);
    const result = await sweepAllExpired(ctx);

    expect(result.wapp).toBe(1);
    expect(result.esc).toBe(1);
    expect(result.ho).toBe(0);
    expect(result.ask).toBe(0);
    expect(result.conf).toBe(0);
  });

  it("drops a stale index entry whose row is already gone, without reporting it as expired", async () => {
    const ctx = mockCtx();
    const key = await park(ctx, "wapp", { n: 1 });
    // Simulate the row having been deleted through some path that forgot to
    // clean the index (defensive: normal `clear()` always does both).
    delete stateStore[`wapp_${key}`];

    const expired = await listExpired(ctx, "wapp");

    expect(expired).toEqual([]);
    const index = stateStore["index_wapp"] as string[];
    expect(index).not.toContain(key);
  });
});
