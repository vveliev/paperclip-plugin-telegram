# Migration: multi-runtime polling → single-owner runtime

`prerelease` was rebased onto `upstream/main` (2026-08-31), and in doing so
gave up its own multi-company polling architecture in favor of upstream's
simpler single-owner model. This note records what changed, why, and what it
costs, so nobody re-derives this from git archaeology again.

## What prerelease had

`config-compat.ts` + `listCompaniesForStartup()` + `resolveCompanyRuntimes()`
+ `TelegramCompanyRuntime`/`TelegramPollingRuntimeGroup` + `polling-dispatch.ts`:

- Enumerate every company at startup.
- Build one runtime per company whose scoped config actually differs from the
  instance config (a "does this company have its own Telegram route" diff
  guard).
- Group runtimes by shared bot token, run one long-polling loop per group,
  and dispatch each incoming update to the runtime whose config's chat IDs
  match it (`selectTelegramRuntimeForUpdate`).

This is real capability: two companies genuinely sharing one bot token get
polled correctly and concurrently.

It was also a recurring source of silent outages. At least three separate
incidents trace back to this exact machinery:

- The diff guard skipped the *only* company when its scoped config happened
  to equal the startup config (the common case, since setup() loads config
  scoped to that company) — polling silently never started.
- Two scheduled jobs (`check-escalation-timeouts`, `check-watches`) called
  `resolveCompanyRuntimes` without the startup company id and hit the same
  guard — jobs ran, logged success, and did nothing (BLA-218, twice).
- `wait_approval`'s callback plumbing broke in a related way during the same
  period of churn.

Notably, prerelease's own history (`6ff51e7`, BLA-620) records that adopting
upstream's deliveries-only rearchitecture was proposed once before (BLA-561)
and **rejected** at the time for conflicting with this multi-company
capability. This migration reopens that decision in upstream's favor.

## What upstream has, and what we adopted

A single-owner model: whichever company's config is delivered first via
`onConfigChanged` claims the runtime (`claimOwnership`), tracked as one
`ownerCompanyId`/`ownerConfigJson` pair. `ensureRuntime()` returns that one
runtime everywhere a handler needs it. A second company's byte-identical
config transfers ownership (handles a host migration duplicating a delivery);
a second company with a *different* config is refused and logged once.

This is a lot less code and a lot fewer states: no per-update dispatch, no
group bookkeeping, no diff guard to get backwards. The tradeoff is explicit:
**this does not support two companies concurrently polling the same bot
token.** If that becomes a real requirement again, the fix is a fresh design
against the current single-owner code, not reviving `resolveCompanyRuntimes`.

## What was dropped

- `src/config-compat.ts`, `src/polling-dispatch.ts` — entire files, no
  remaining callers.
- `resolveCompanyRuntimes`, `resolveTelegramBotToken`/`resolveTelegramBotTokenRef`
  (the local worker.ts versions — a same-named function still exists,
  imported from `runtime-token.ts`), `listCompaniesForStartup`,
  `TelegramCompanyRuntime`, `TelegramPollingRuntimeGroup`,
  `selectTelegramRuntimeForUpdate`, `getTelegramUpdateChatId` — all
  worker.ts-local, all unused once the above files are gone.
- Digest scheduling was briefly refactored into `resolveDigestMode` /
  `parseDigestTime` / `digestTimesForConfig` / `resolveDigestSlot` (minute-
  precision, slot-keyed dedup) as part of the same multi-runtime-era work.
  Upstream's current digest job uses a simpler hour-only `parseHour` check
  with a "fire once within the first 5 minutes of the hour" window — that's
  what survived. The finer-grained slot helpers were dropped along with the
  architecture that needed them.
- Test files that existed solely to cover the above:
  `tests/worker-company-runtimes.test.ts`, `tests/worker-setup.test.ts`
  (three separate commits added to it: setup()-closure coverage, a
  governed-host config.get denial regression, and a 409/ok:false getUpdates
  regression — all three targeted the old setup() closure specifically and
  don't carry over).
- A handful of commits were pure duplicates of what's already in
  `upstream/main` under a different hash (same fix, authored independently
  or cherry-picked with edits) — those were skipped outright rather than
  reapplied.

## What was restored that upstream's migration had silently dropped

`enrichRunIssue` — a small, architecture-agnostic helper that fills in
`payload.issueIdentifier` from `payload.issueId` for `agent.run.started` /
`agent.run.finished` notifications — existed in prerelease before the
multi-runtime work and was lost as a side effect of upstream's
`fix(worker): bootstrap Telegram runtime from config deliveries` rewrite
(commit `664ccd8`), which rewrote those two handlers without carrying it
forward. It's been re-added as a top-level function alongside
`enrichAgentName`, wired into both handlers. This wasn't part of the
architecture decision either way — it's an unrelated notification-quality
regression that happened to ride along with the rewrite.

## Known gaps after this migration

*Updated 2026-09-04: two of the three gaps below were closed by commit
`9940963`, which recovered and adapted the dropped tests. Superseded text is
kept as a record of what the state was immediately after the rebase.*

- ~~**No regression test for `pollUpdates`'s `ok:false` branch**~~ —
  **closed.** The 409/ok:false test (`8b841be`) was ported to the current
  single-owner loop and passes; it lives in `tests/worker-setup.test.ts` as
  "drops a 409/ok:false getUpdates response without dispatching or advancing
  the offset".
- ~~**No regression coverage for the single-owner `setup()` closure**~~ —
  **largely closed.** `tests/worker-setup.test.ts` was rebuilt against the
  deliveries-only architecture: it boots in two steps (`setup()` to register,
  then `onConfigChanged` to deliver) via a `boot()` helper, and takes a fresh
  module instance per test because the runtime lives in module-level state.
  33 tests covering the registration surface, event subscriptions, Activity
  topic routing, the escalation/watch jobs, bot-command registration,
  governed-host denial, and the polling loop. Tests written against the
  removed multi-runtime model were rewritten against what replaced it rather
  than deleted — per-company runtime wiring became one delivered runtime, and
  the "no runtime matched this chat" warning became the allowlist drop.
  `tests/worker-board-token.test.ts` additionally covers `resolveBoardApiToken`
  and `BOARD_TOKEN_COMMANDS`, which the rebase left exported with no test at all.
- ~~Coverage thresholds re-ratcheted down~~ — **restored.** `vitest.config.ts`
  is back to 84/78/95/84 with `telegram-api.ts` statements at 88, plus a new
  floor on `src/worker.ts` (75 statements / 90 functions) so this harness
  cannot rot away unnoticed a second time. `worker.ts` went 62.71% → 76.33%
  statements; overall 83.51% → 86.27%.

### Closed: daily-digest behaviour (step 03)

*Updated 2026-09-04.* The gap described below is closed. `telegram-daily-digest`,
`check-escalation-timeouts`, and `check-watches` now all accept the job
context the host was already passing them (`job.scheduledAt`, `job.trigger`)
instead of declaring no parameters and reading the wall clock — the exact
shape of the BLA-218 outage this note opened with, where a job ran, logged
success, and silently did nothing relative to what it was actually asked to
do.

`resolveDigestMode` / `parseDigestTime` / `digestTimesForConfig` /
`resolveDigestSlot` were ported back into `worker.ts` (adapted for the
single-owner runtime, not restored verbatim from
`origin/prerelease-pre-rebase-backup` `c36e532`). The digest job now:

- keys slot matching off `job.scheduledAt`, not `new Date()`;
- honors `trigger: "manual"` — a manual run sends immediately regardless of
  slot, with no dedup marker;
- writes a `digest_sent_<date>_<slot>` marker (scoped per company) after a
  successful scheduled send, so a slot fires at most once.

`check-escalation-timeouts` and `check-watches` now thread the job's
`scheduledAt` through as `now` (`EscalationManager.checkTimeouts`'s new `now`
parameter; `checkWatches`'s new `now` parameter, which also retimes the
hourly rate-limit bucket key and the suggestion dedup window) instead of
calling `Date.now()` internally, so both are testable against a controlled
clock. Both parameters default to `Date.now()` when omitted, so this is
additive — no existing caller broke.

Five of the six quarantined tests in `tests/worker-setup.test.ts` were
un-quarantined (`describe.skip` → `describe`) and pass unmodified against the
new implementation. The sixth — "skips a company with digest mode off without
affecting a sibling company" — was deleted rather than restored: it asserts
per-company `digestMode`, which the single-owner runtime (one delivered
config for the whole plugin) structurally cannot express. Restoring it would
silently re-litigate that decision. Step 04's per-company runtimes make this
expressible again; it should reintroduce per-company digest mode
deliberately then, not inherit a pre-built test for it now.

## Where to look

`git log --oneline upstream/main..prerelease` shows what's left ahead of
upstream after this rebase — almost entirely genuine prerelease-only work
(commands, fixes, tests) with no further architecture-specific content.
