import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { BOARD_TOKEN_COMMANDS, resolveBoardApiToken } from "../src/worker.js";

/**
 * Regression tests for the board API token path.
 *
 * Every bug these hold down failed the same way — silently. Nothing threw,
 * nothing logged an error, and the user saw a plugin that looked connected and
 * did nothing. That is precisely the failure a test has to hold down, because
 * the next person to touch this code gets no signal from running it.
 */
function makeCtx(over: {
  state?: unknown;
  resolve?: (ref: unknown, opts: unknown) => Promise<string>;
} = {}): PluginContext {
  return {
    companies: { list: async () => [] },
    state: { get: vi.fn(async () => over.state ?? null) },
    secrets: {
      resolve: over.resolve ?? vi.fn(async () => "resolved-token"),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

describe("BOARD_TOKEN_COMMANDS", () => {
  // The coupling this guards: a command that hits a board-only endpoint but is
  // missing from this set sends its request unauthenticated, and the user gets
  // a bare 403 with nothing naming the cause. /decisions shipped that way.
  it("includes every command whose handler needs the board token", () => {
    expect(BOARD_TOKEN_COMMANDS.has("decisions")).toBe(true);
    expect(BOARD_TOKEN_COMMANDS.has("approve")).toBe(true);
  });

  it("does not resolve a secret for commands that do not need one", () => {
    // Deliberately on-demand: resolving a secret on every /help would be waste.
    expect(BOARD_TOKEN_COMMANDS.has("help")).toBe(false);
    expect(BOARD_TOKEN_COMMANDS.has("start")).toBe(false);
    expect(BOARD_TOKEN_COMMANDS.has("status")).toBe(false);
  });
});

describe("resolveBoardApiToken", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";

  it("normalizes the bare UUID that board-access state persists", async () => {
    // The bug: board access stores a bare UUID, but the host rejects anything
    // other than {type:"secret_ref",secretId}. Passing it through unchanged
    // surfaced as an unexplained 403 from whatever needed the token.
    const resolve = vi.fn(async () => "board-token");
    const ctx = makeCtx({ state: { paperclipBoardApiTokenRef: UUID }, resolve });

    const token = await resolveBoardApiToken(ctx, {} as never, "c1");

    expect(token).toBe("board-token");
    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: UUID },
      expect.objectContaining({ companyId: "c1" }),
    );
  });

  it("passes configPath for the config ref, because the binding is keyed on it", async () => {
    const resolve = vi.fn(async () => "config-token");
    const ctx = makeCtx({ state: null, resolve });

    await resolveBoardApiToken(ctx, { paperclipBoardApiTokenRef: UUID } as never, "c1");

    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: UUID },
      expect.objectContaining({ configPath: "paperclipBoardApiTokenRef" }),
    );
  });

  it("falls through to the config ref when board-access state fails to resolve", async () => {
    const other = "99999999-2222-3333-4444-555555555555";
    const resolve = vi.fn(async (ref: unknown) => {
      if ((ref as { secretId: string }).secretId === UUID) throw new Error("not bound");
      return "config-token";
    });
    const ctx = makeCtx({ state: { paperclipBoardApiTokenRef: UUID }, resolve });

    const token = await resolveBoardApiToken(
      ctx,
      { paperclipBoardApiTokenRef: other } as never,
      "c1",
    );

    expect(token).toBe("config-token");
  });

  it("ignores board-access state belonging to a different company", async () => {
    const resolve = vi.fn(async () => "board-token");
    const ctx = makeCtx({
      state: { paperclipBoardApiTokenRef: UUID, companyId: "c-other" },
      resolve,
    });

    expect(await resolveBoardApiToken(ctx, {} as never, "c1")).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns undefined rather than throwing when nothing resolves", async () => {
    const ctx = makeCtx({ state: null });
    expect(await resolveBoardApiToken(ctx, {} as never, "c1")).toBeUndefined();
  });

  it("skips a ref that is not a usable secret reference instead of calling resolve", async () => {
    const resolve = vi.fn(async () => "never");
    const ctx = makeCtx({ state: { paperclipBoardApiTokenRef: "not-a-uuid" }, resolve });

    expect(await resolveBoardApiToken(ctx, {} as never, "c1")).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});
