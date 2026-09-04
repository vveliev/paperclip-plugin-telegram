# ADR 0001: Patch `BUILTIN_COMMANDS` drift now, not after the command-table rewrite

Date: 2026-09-04
Status: Accepted
Related: GIF-149 (step 00)

## Context

`worker.ts` runs `tryCustomCommand` before the built-in dispatcher. A
company-imported custom command whose name is dispatchable but missing from
`BUILTIN_COMMANDS` therefore passes the "cannot override a built-in" check on
import, and then permanently shadows the real handler. On the fork this
currently affects `create`, `decisions`, `keyboard`, `start`; upstream
affects `clear`, `create`, `list`, `remove`, `start`. `start` is the worst
case — it's the first message a new user sends.

Step 07c (ADR 0010) will eventually collapse `BUILTIN_COMMANDS` and four
sibling lists into one table with derived views, which removes this defect
class structurally. But that work sits behind PRs #96, #97 and GIF-144, and
this is a live, user-facing shadowing bug today.

## Decision

Fix immediately rather than wait for the command-table rewrite. Add the
missing names to `BUILTIN_COMMANDS` (4 on the fork, 5 upstream), and add a
drift-guard test asserting `BUILTIN_COMMANDS` covers every dispatchable
`switch` case in `handleCommand` — mirroring the `HELP_GROUPS`/`BOT_COMMANDS`
guard that already exists and is the reason that pair has never drifted.

## Consequences

The live shadowing hole closes now instead of waiting on three gated PRs.
The drift-guard test added here becomes redundant once ADR 0010's single
command table lands — at that point it should be removed with a note
pointing to ADR 0010, not left running against code that can no longer
drift.
