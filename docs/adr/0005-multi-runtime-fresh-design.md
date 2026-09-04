# ADR 0005: Multi-runtime is a fresh design, not a restoration of the pre-rebase implementation

Date: 2026-09-04
Status: Accepted
Related: GIF-154 (step 04), upstream issue #99, `docs/architecture-migration.md`

## Context

A second company needing its own bot token is a real, upstream-confirmed
requirement — issue #99 explicitly invited this fork to contribute the
implementation, since it's the only one that has run in production.

The pre-rebase implementation
(`origin/prerelease-pre-rebase-backup`, `c36e532`: `resolveCompanyRuntimes`,
`TelegramCompanyRuntime`, `TelegramPollingRuntimeGroup`,
`selectTelegramRuntimeForUpdate`, `config-compat.ts`, `polling-dispatch.ts`)
already solved this once, but `docs/architecture-migration.md` records it as
"a recurring source of silent outages" — three separate incidents traced
back to its token-grouped-poller dispatch layer. It also persisted the
polling offset to one flat `TELEGRAM_LAST_UPDATE_ID_STATE_KEY`, which only
worked because exactly one token was ever polled; a second, distinct token
would silently skip that bot's backlog.

Confirmed 2026-09-04: bot tokens are 1:1 with companies. That removes the
hard part the old implementation solved (grouping multiple companies sharing
one token) — a problem this rewrite does not need to re-solve.

## Decision

Design fresh against the current single-owner code rather than restore the
old implementation. Target shape: `Map<companyId, TelegramRuntime>`, one
poller per company, offset keyed by bot token (closes the flat-key
backlog-skip defect by construction), health carrying a per-company status
and reason. No `selectTelegramRuntimeForUpdate`, no `polling-dispatch.ts`, no
token-grouped pollers — each poller serves exactly one company and knows
which. `claimOwnership`, `ownerCompanyId`, `ownerConfigJson`, and
`refusedCompanies` are deleted, not adapted.

Explicit failure-mode rules — the failure model is the point of the
rewrite, not a detail of it:

| Situation | Behaviour | Why |
|---|---|---|
| A company's runtime cannot build | Others keep polling; reason recorded per company in health | Silence here caused three of the old outages |
| Two companies present the same token | Second refused and surfaced | Two pollers on one token → Telegram 409 → both break |
| Config delivery cannot be attributed | Refused, never guessed | Preserves the cross-tenant attribution fix from upstream #86 |
| Offset persistence | Keyed by bot token | A flat key silently skips another bot's backlog |

If a shared-token deployment ever appears, that's a separate design, not a
flag on this one.

Process exception: fork first, tested live against the real multi-company
fleet, then upstream — a deliberate departure from converge-as-you-go,
justified by the size of the change and that the fork is what actually runs
in production.

## Consequences

Depends on steps 01, 02, 03 (ADRs 0002–0004) landing first — the
invocation-scope fix this stands on, and the two surfaces (company lookup,
job context) it must not be built on top of in their pre-step state. Once it
lands, [[Company runtime]] becomes a real per-company `Map` entry rather than
a single module-level owner, and ADR 0004's retired digest test can be
reintroduced as new work if the capability is still wanted.
