# ADR 0010: Command name lists collapse into one table with derived views

Date: 2026-09-04
Status: Accepted
Related: GIF-159 (step 07c), upstream issue #98

## Context

Five separate literals each independently answer "is this command name
special": `BOT_COMMANDS` (the Telegram menu, 14 entries), the `switch` cases
in `handleCommand` (dispatch, 15 names), `BUILTIN_COMMANDS` (the override
guard, 11 names), `BOARD_TOKEN_COMMANDS` (which commands need a board
token), and `HELP_GROUPS` (help text grouping). Only one pair —
`HELP_GROUPS` vs `BOT_COMMANDS` — has a drift-guard test, and it's the only
pair that has never drifted; `BUILTIN_COMMANDS` drifted, and that drift is
the live shadowing defect fixed directly in ADR 0001 rather than waiting for
this step.

Separately, `handleCommand` takes 13 positional parameters and no case uses
more than 8 (`tests/commands.test.ts:656` passes 8 leading `undefined`s just
to reach `chatType`). `isExternalUrl` is defined byte-identically and
privately in both `commands.ts:206` and `formatters.ts:70`. `tryCustomCommand`
refuses to fall back to `chatId` as a company id, while its four siblings
(`listCommands`, `importCommand`, `deleteCommand`, `runCommand`) each write
`companyId ?? chatId` — filed upstream as issue #98.

## Decision

One command table; menu, dispatch, the override guard, and token gating
become derived views over it, so drift stops being possible rather than
being tested for. Fold in the `isExternalUrl` de-duplication and a
`handleCommand` signature reduction while touching these files. ADR 0001's
drift-guard test becomes redundant once this lands and should be removed
with a note pointing here, not left running against code that can no longer
drift.

## Consequences

Gated on #96, #97 and GIF-144, which all touch the same files. Makes
upstream #98 answerable as part of the same pass.
