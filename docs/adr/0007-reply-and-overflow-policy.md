# ADR 0007: Reply construction takes structured parts; overflow policy is caller-declared

Date: 2026-09-04
Status: Accepted
Related: GIF-155 (step 06)

## Context

`sendMessage` never measures `text.length`. An over-length reply gets one
useless retry as stripped plain text, then logs an error and returns `null`
— and 106 of 116 call sites discard that `null` with a bare
`await sendMessage(...)`, so the user sees nothing. This is the one place
the architecture contradicts the project's stated goal of failing loudly
rather than silently.

Five modules independently implement overflow handling against two
different length budgets, with no shared constant for Telegram's real
4096-character limit (which appears only in comments and test names):
`commands.ts` accumulates and breaks at 3500, `acp-bridge.ts` splits into
chunks at 4000, `constants.ts` truncates at word boundaries at
200/300/350/500 depending on call site, `decisions.ts` slices with no word
boundary, `media-pipeline.ts` has an inline 500 literal. `commands.ts` alone
calls `escapeMarkdownV2` 42 times and never imports `formatters.ts`; hand-
escaped punctuation appears 58 times across six modules.

## Decision

Callers construct a [[Reply]] from structured parts (text, bold, code, link,
list); a new module owns escaping, parse mode, fitting, and chunking, making
hand-escaping at call sites unrepresentable. The caller declares the
[[Overflow policy]] — `split` | `paginate` | `truncate` — with no default,
because a default is exactly how a call site silently gets it wrong; the
five existing strategies exist for real, distinct reasons (streaming ACP
output must split, a list wants a Show-more affordance, an error line should
truncate). Migration strangles the old call sites rather than sweeping them:
the new module wraps `sendMessage`, and a test asserts no new direct callers
of the raw API appear.

## Consequences

`tests/parse-mode-convention.test.ts`, which enforces "every send declares a
parse mode" by regex-scanning source text (because the invariant isn't
expressible in the type today), is deleted once `parseMode` becomes a
required field on the interface instead of a scanned convention. Call sites
migrate per file as PRs #92/#95/#96/#97 merge, not in one sweep.
