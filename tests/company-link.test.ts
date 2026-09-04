import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { chatLinkStateKey, lookupCompanyLink, NOT_LINKED_MESSAGE } from "../src/company-link.js";

function mockCtx(state: unknown): PluginContext {
  return {
    state: {
      get: vi.fn(async () => state),
      set: vi.fn(),
    },
  } as unknown as PluginContext;
}

function throwingCtx(): PluginContext {
  return {
    state: {
      get: vi.fn(async () => {
        throw new Error("state store unavailable");
      }),
      set: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("lookupCompanyLink", () => {
  it("reads the chat_<chatId> key", async () => {
    const ctx = mockCtx({ companyId: "co-1" });
    await lookupCompanyLink(ctx, "chat-1");
    expect(ctx.state.get).toHaveBeenCalledWith({ scopeKind: "instance", stateKey: "chat_chat-1" });
    expect(chatLinkStateKey("chat-1")).toBe("chat_chat-1");
  });

  it("reports linked with the stored companyId", async () => {
    const ctx = mockCtx({ companyId: "co-1", companyName: "Acme" });
    const result = await lookupCompanyLink(ctx, "chat-1");
    expect(result).toEqual({ linked: true, companyId: "co-1", companyName: "Acme" });
  });

  it("falls back to companyName when companyId is missing (older /connect links)", async () => {
    const ctx = mockCtx({ companyName: "Acme" });
    const result = await lookupCompanyLink(ctx, "chat-1");
    expect(result).toEqual({ linked: true, companyId: "Acme", companyName: "Acme" });
  });

  it("reports not-linked when there is no mapping", async () => {
    const ctx = mockCtx(null);
    const result = await lookupCompanyLink(ctx, "chat-1");
    expect(result).toEqual({ linked: false });
  });

  it("reports not-linked instead of throwing when the state store fails", async () => {
    const ctx = throwingCtx();
    await expect(lookupCompanyLink(ctx, "chat-1")).resolves.toEqual({ linked: false });
  });

  it("exposes the shared not-linked copy every caller sends", () => {
    expect(NOT_LINKED_MESSAGE).toContain("/connect");
  });
});
