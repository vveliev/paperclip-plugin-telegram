# ADR 0008: `src/config.ts` becomes the single source of truth for plugin configuration

Date: 2026-09-04
Status: Accepted
Related: GIF-157 (step 07a)

## Context

Configuration is declared three times with nothing checking they agree:
`manifest.ts` (the JSON schema the host validates against), `constants.ts`
(`DEFAULT_CONFIG`, 41 keys), and `ui/index.tsx` (7 typed groups, 7 default
objects, 7 `extract*` coercers). The only typed statement of the config
lives in `ui/index.tsx`, which `vitest.config.ts` excludes from coverage
entirely, so it has zero tests. The worker re-reads the same keys as
untyped strings elsewhere (`paperclipBoardApiTokenRef` ×16, `digestMode` ×4,
`escalationDefaultAction` ×3). `ui/index.tsx` also carries its own
`asString`/`asBoolean`/`asNumber`/`asStringArray`, duplicating
`src/coerce.ts` — whose own doc comment claims to be "the one place that
decision gets made" — and imports nothing from `src/` at all.

## Decision

New `src/config.ts` owns types, defaults, and `decode(unknown)`. The
manifest schema and `DEFAULT_CONFIG` derive from it, or are checked against
it by a drift test. `TelegramSettingsPage` (`ui/index.tsx:630–2305`, a
single 1,675-line function) is not refactored as part of this step — only
the schema is extracted; rendering stays where it is.

## Consequences

Lifts pure, testable decoding out of the coverage exclusion without
weakening that exclusion, which was always about JSX and never about the
schema. Gated on GIF-145 (rewriting `ui/index.tsx` for design tokens) —
land that first or coordinate, since both touch the same 1,675-line
function.
