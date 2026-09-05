import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// "Strangle, don't sweep." src/reply.ts is now the one place new
// code should reach for when it needs to send a Telegram message that might
// not fit -- it owns escaping, parse mode, and fitting so a call site can't
// silently get "a reply that fits" wrong the way the five ad hoc strategies
// this issue found did.
//
// The 116 existing call sites across this list are not touched yet --
// migrating them is a per-file job for the follow-up PRs the issue names
// (#92/#95/#96/#97). This test's only job is to stop the list from growing:
// a brand-new file added after this one that calls telegram-api's raw
// `sendMessage` directly, instead of going through src/reply.ts, should fail
// CI rather than quietly adding a fourth budget and a sixth strategy.

const SRC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src");

// telegram-api.ts defines sendMessage (and calls itself once, recursively,
// for the plain-text retry) -- it is the callee, not a caller, so it is
// exempt from this scan the same way the function declaration line is.
const DEFINING_FILE = "telegram-api.ts";

// src/reply.ts is the new wrapper this issue adds; calling sendMessage is
// its entire job.
const KNOWN_DIRECT_CALLERS = new Set([
  "acp-bridge.ts",
  "adapter.ts",
  "command-registry.ts",
  "commands.ts",
  "decisions.ts",
  "escalation.ts",
  "interaction-answers.ts",
  "media-pipeline.ts",
  "reply.ts",
  "watch-registry.ts",
  "worker.ts",
]);

/** Extract the balanced-paren argument text of a call starting at `openParenIndex` (index of "("). */
function extractCallArgs(src: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIndex + 1, i);
    }
  }
  throw new Error("Unbalanced parens while scanning a sendMessage call");
}

function callsSendMessage(src: string): boolean {
  const re = /(^|[^.\w])sendMessage\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const nameStart = m.index + m[1].length;
    const openParenIndex = nameStart + "sendMessage".length;
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineEnd = src.indexOf("\n", m.index);
    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (/^\s*(export\s+async\s+function\s+sendMessage|\/\/|\*)/.test(line)) continue;
    // Confirm it is a real, syntactically valid call site (mirrors the
    // parse-mode-convention scan) rather than a partial/commented match.
    extractCallArgs(src, openParenIndex);
    return true;
  }
  return false;
}

describe("no new direct callers of telegram-api's sendMessage", () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts") && f !== DEFINING_FILE);

  it("scanned at least one file with a real sendMessage call, so the scan itself isn't silently broken", () => {
    const callers = files.filter((f) => callsSendMessage(readFileSync(path.join(SRC_DIR, f), "utf8")));
    expect(callers.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} only calls sendMessage directly if it is on the known allowlist`, () => {
      const src = readFileSync(path.join(SRC_DIR, file), "utf8");
      if (callsSendMessage(src)) {
        expect(
          KNOWN_DIRECT_CALLERS.has(file),
          `${file} calls telegram-api's sendMessage directly but is not on the allowlist. ` +
            "New call sites should go through src/reply.ts's sendFittedReply instead of " +
            "reaching for the raw transport. If this file is intentionally " +
            "migrating to a direct call for a documented reason, add it to KNOWN_DIRECT_CALLERS.",
        ).toBe(true);
      }
    });
  }
});
