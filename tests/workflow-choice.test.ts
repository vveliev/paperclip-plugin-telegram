import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const sentMessages: Array<{ text: string; inlineKeyboard?: unknown }> = [];

vi.mock("../src/telegram-api.js", () => ({
  sendMessage: vi.fn(async (_ctx: unknown, _token: string, _chatId: string, text: string, opts?: { inlineKeyboard?: unknown }) => {
    sentMessages.push({ text, inlineKeyboard: opts?.inlineKeyboard });
    return { ok: true };
  }),
}));

const {
  askChoice,
  normalizeOptions,
  isChoiceCallback,
  resolveChoiceCallback,
  pendingChoiceCount,
} = await import("../src/workflow-choice.js");

const ctx = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;

/**
 * askChoice awaits sendMessage before registering its pending entry, so tests
 * must let those microtasks run before inspecting the keyboard or the registry.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Pull the callback_data Telegram would send back for a given button index. */
function callbackDataFor(buttonIndex: number): string {
  const keyboard = sentMessages.at(-1)?.inlineKeyboard as Array<Array<{ callback_data: string }>>;
  return keyboard.flat()[buttonIndex]!.callback_data;
}

describe("normalizeOptions", () => {
  it("accepts plain strings and uses them as both label and value", () => {
    expect(normalizeOptions(["high", "low"])).toEqual([
      { label: "high", value: "high" },
      { label: "low", value: "low" },
    ]);
  });

  it("accepts {label,value} pairs so display can differ from the stored value", () => {
    expect(normalizeOptions([{ label: "High priority", value: "high" }])).toEqual([
      { label: "High priority", value: "high" },
    ]);
  });

  it("drops malformed entries rather than producing unusable buttons", () => {
    expect(normalizeOptions([null, 42, {}, { label: "ok" }])).toEqual([{ label: "ok", value: "ok" }]);
  });

  it("returns empty for a non-array", () => {
    expect(normalizeOptions("high")).toEqual([]);
  });
});

describe("askChoice", () => {
  beforeEach(() => {
    sentMessages.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the chosen option's value when the button is pressed", async () => {
    const pendingAnswer = askChoice(ctx, "tok", "chat-1", "Priority?", [
      { label: "High priority", value: "high" },
      { label: "Low priority", value: "low" },
    ]);
    await flush();

    expect(pendingChoiceCount()).toBe(1);
    expect(resolveChoiceCallback(callbackDataFor(1))).toBe(true);
    await expect(pendingAnswer).resolves.toBe("low");
    expect(pendingChoiceCount()).toBe(0);
  });

  it("keeps callback_data short by encoding the option index, not its value", async () => {
    const longValue = "x".repeat(200);
    const pendingAnswer = askChoice(ctx, "tok", "chat-1", "Pick", [{ label: "L", value: longValue }]);
    await flush();

    const data = callbackDataFor(0);
    // Telegram rejects callback_data over 64 bytes.
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);

    resolveChoiceCallback(data);
    await expect(pendingAnswer).resolves.toBe(longValue);
  });

  it("resolves null on timeout and stops waiting", async () => {
    const pendingAnswer = askChoice(ctx, "tok", "chat-1", "Priority?", [{ label: "High", value: "high" }], {
      timeoutMs: 1000,
    });
    await flush();

    vi.advanceTimersByTime(1001);
    await expect(pendingAnswer).resolves.toBeNull();
    expect(pendingChoiceCount()).toBe(0);
  });

  it("reports an unknown callback so the handler can say the choice expired", () => {
    // This is the post-restart case: the registry is in memory, so a button
    // pressed after a worker restart has nothing waiting for it.
    expect(resolveChoiceCallback("wfc_missing_0")).toBe(false);
  });

  it("returns null without sending anything when there are no options", async () => {
    await expect(askChoice(ctx, "tok", "chat-1", "Pick", [])).resolves.toBeNull();
    expect(sentMessages).toHaveLength(0);
  });

  it("lays buttons out in the requested number of columns", async () => {
    const pendingAnswer = askChoice(
      ctx,
      "tok",
      "chat-1",
      "Pick",
      normalizeOptions(["a", "b", "c", "d"]),
      { columns: 2 },
    );
    await flush();

    const keyboard = sentMessages.at(-1)?.inlineKeyboard as unknown[][];
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0]).toHaveLength(2);

    resolveChoiceCallback(callbackDataFor(0));
    await pendingAnswer;
  });
});

describe("isChoiceCallback", () => {
  it("claims only its own prefix, leaving other button handlers alone", () => {
    expect(isChoiceCallback("wfc_abc_0")).toBe(true);
    expect(isChoiceCallback("approve_123")).toBe(false);
    expect(isChoiceCallback("esc_123")).toBe(false);
    expect(isChoiceCallback("cmd_approve_123")).toBe(false);
  });
});
