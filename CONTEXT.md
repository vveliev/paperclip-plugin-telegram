# Domain vocabulary

Terms coined during the 2026-09-04 architecture review (`docs/adr/`) that
aren't written down anywhere else. None of these exist in the code yet as of
this writing — they're the target shape the step 02–08 issues (GIF-149
through GIF-160) build toward. Once a term's module lands, prefer reading the
module's own doc comment over this file for anything the code already says
clearly; this file is for the parts that don't fit in a docstring.

## Reply

Structured content sent to a chat: parts (text, bold, code, link, list) plus
an [[Overflow policy]]. Not a string.

Today, replies are ad hoc strings built independently in five modules, each
with its own escaping and length-budget logic. The target module owns
escaping, parse mode, fitting, and chunking, so a call site constructs a
Reply and never touches `escapeMarkdownV2` or a raw length budget directly.
See ADR 0007 (`docs/adr/0007-reply-and-overflow-policy.md`).

## Overflow policy

`split` | `paginate` | `truncate`. Declared by the caller constructing a
[[Reply]], never defaulted — a default is exactly how a call site silently
picks the wrong one. The three values aren't arbitrary: streaming ACP output
must split, a list wants a Show-more affordance (paginate), and a one-line
error should truncate rather than fragment.
See ADR 0007 (`docs/adr/0007-reply-and-overflow-policy.md`).

## Parked interaction

State saved because a handler cannot await a button press — Telegram updates
are strictly sequential, so awaiting one inside a handler deadlocks. A parked
interaction has a key, a liveness rule (what makes it "expired" rather than
just unanswered), and a TTL.

Today there are six flows (ask_user_questions, wait_approval, escalation,
handoff, approval notice, decisions paging), each with its own
`callback_data` format, parsing idiom, and liveness sentinel, and only one of
the six ever cleans up its own row. The target is one module owning key
allocation, encode/decode, the liveness rule, and expiry (TTL + sweeper) for
all six. See ADR 0009 (`docs/adr/0009-parked-interactions.md`).

## Transport adapter

The native/ACP seam: `spawn` / `send` / `terminate`. Two adapters — native
(via `ctx.agents.sessions` / `wakeAgentWithIssue`) and ACP (via
`ctx.events.emit`) — behind one interface, replacing the ten sites in
`acp-bridge.ts` that currently re-test the string literal
`transport === "acp"` by hand. A third transport becomes one new adapter, not
ten edits. See ADR 0011 (`docs/adr/0011-transport-adapter.md`).

## Company runtime

One company's token, config, poller, and health. Currently there is exactly
one of these module-wide (the single-owner model — see
`docs/architecture-migration.md`). Step 04 replaces that with
`Map<companyId, TelegramRuntime>`: one poller per company (bot tokens are 1:1
with companies), the polling offset keyed by bot token instead of one flat
key, and health carrying a per-company status and failure reason instead of
one shared state. See ADR 0005 (`docs/adr/0005-multi-runtime-fresh-design.md`).
