import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// GIF-42: every sendMessage call site must set parseMode explicitly — either
// to "MarkdownV2"/"HTML", or to `undefined` with a comment explaining why
// plain text is the deliberate choice. A structural scan rather than a
// behavioural test, because the failure mode is a NEW call site added later
// that quietly omits the field — no unit test of an individual formatter can
// see that, the same reasoning as the resolveCompanyRuntimes call-site check
// in worker-company-runtimes.test.ts.

const SRC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src");

// Call sites where the options object is threaded in from elsewhere instead
// of being a literal at the call site, so `parseMode` does not appear in the
// call's own text. Each is a variable/property built with an explicit
// `parseMode` a few lines above its use — verified by the file-specific
// assertions below, not just waved through.
const INDIRECT_OPTIONS_ARG: Record<string, string> = {
  "worker.ts": "msg.options",
  "adapter.ts": "options",
};

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

function findSendMessageCallArgs(src: string): string[] {
  const calls: string[] = [];
  // Matches "sendMessage(" not preceded by a "." (so "sessions.sendMessage(" in
  // a comment, or any future method named sendMessage on another object,
  // is not treated as this module's own call site).
  const re = /(^|[^.\w])sendMessage\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const nameStart = m.index + m[1].length;
    const openParenIndex = nameStart + "sendMessage".length;
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineEnd = src.indexOf("\n", m.index);
    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    // Skip the function declaration itself and any mention inside a comment.
    if (/^\s*(export\s+async\s+function\s+sendMessage|\/\/|\*)/.test(line)) continue;
    calls.push(extractCallArgs(src, openParenIndex));
  }
  return calls;
}

describe("every sendMessage call site has an explicit parse mode (GIF-42)", () => {
  const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));

  it("scanned at least one file with a real sendMessage call", () => {
    // Guards against the scan itself silently finding nothing (e.g. a path
    // typo) and every per-file check below vacuously passing.
    const total = files
      .map((f) => findSendMessageCallArgs(readFileSync(path.join(SRC_DIR, f), "utf8")).length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(100);
  });

  for (const file of files) {
    it(file, () => {
      const src = readFileSync(path.join(SRC_DIR, file), "utf8");
      const indirectArg = INDIRECT_OPTIONS_ARG[file];
      for (const args of findSendMessageCallArgs(src)) {
        const isExplicit =
          /\bparseMode\s*:/.test(args) ||
          (indirectArg !== undefined && args.trimEnd().endsWith(indirectArg));
        expect(isExplicit, `${file}: sendMessage(${args.trim().slice(0, 80)}...) has no explicit parseMode`).toBe(true);
      }
    });
  }
});

describe("the two indirect-options sendMessage call sites are themselves explicit", () => {
  it("worker.ts builds msg.options from a formatter that always sets parseMode", () => {
    const formatters = readFileSync(path.join(SRC_DIR, "formatters.ts"), "utf8");
    // Every exported formatXxx returns { text, options: { parseMode: ..., ... } }.
    const returned = [...formatters.matchAll(/return \{\s*text:[\s\S]*?options: \{([\s\S]*?)\n {4}\},?\s*\n {2}\};/g)];
    expect(returned.length).toBeGreaterThan(0);
    for (const [, optionsBody] of returned) {
      expect(optionsBody).toMatch(/parseMode\s*:/);
    }
  });

  it("adapter.ts builds its local `options` with parseMode before every sendMessage call", () => {
    const src = readFileSync(path.join(SRC_DIR, "adapter.ts"), "utf8");
    const declarations = [...src.matchAll(/const options: SendMessageOptions = \{([\s\S]*?)\};/g)];
    expect(declarations.length).toBeGreaterThanOrEqual(2);
    for (const [, body] of declarations) {
      expect(body).toMatch(/parseMode\s*:\s*"MarkdownV2"/);
    }
  });
});
