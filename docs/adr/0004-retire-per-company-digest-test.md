# ADR 0004: Retire the per-company digest test under single-owner; reintroduce deliberately under multi-runtime

Date: 2026-09-04
Status: Accepted
Related: GIF-153 (step 03), GIF-154 (step 04, ADR 0005), `docs/architecture-migration.md`

## Context

`docs/architecture-migration.md` records that `check-escalation-timeouts`
and `check-watches` both called `resolveCompanyRuntimes` without the startup
company id, hit the diff guard, and **ran, logged success, and did nothing**
(BLA-218, twice). All three of this plugin's scheduled jobs
(`telegram-daily-digest`, `check-escalation-timeouts`, `check-watches`)
currently ignore the `scheduledAt`/`trigger` context the host passes into
every job and read the wall clock instead — which is exactly how that bug
class returns if per-company runtimes are rebuilt on top of jobs that can't
be tested against a controlled clock.

Six digest tests are quarantined as `describe.skip` in
`tests/worker-setup.test.ts`. Two assert zero sends and can never fail as
written (they vary `scheduledAt`, which nothing reads; one seeds a
`digest_sent_` key the current implementation never writes). Of the
remaining four, one — *"skips a company with digest mode off without
affecting a sibling company"* — asserts **per-company** digest config: a
company with `digestMode: "off"` is silently skipped while a sibling company
with digest mode on still receives its own digest.

The single-owner runtime (`docs/architecture-migration.md`, "What upstream
has, and what we adopted") tracks exactly one
`ownerCompanyId`/`ownerConfigJson` pair. There is no second company's config
in scope for a digest job to consult under that model, so "does a sibling
company still get its digest" is not expressible against it today —
restoring the test as-is would silently re-litigate the single-owner
decision (`docs/architecture-migration.md`) rather than test anything real
in the current code.

## Decision

This decision has two parts, and a future reader needs both or the second
half of ADR 0005 (multi-runtime) will look like it contradicts this one:

1. **Now, under single-owner (step 03):** port the five digest tests whose
   assertions the single-owner model can express (job-context-driven timing,
   slot dedup, manual trigger) once the three jobs take `scheduledAt`/
   `trigger` instead of the wall clock. Delete the sixth — the per-company
   skip test — with a comment recording why: it asserts per-company
   ([[Company runtime]]-scoped) config that the single-owner model
   structurally cannot express. Do not pre-build for its return in step 03.

2. **Later, under multi-runtime (step 04, ADR 0005):** once per-company
   runtimes exist as `Map<companyId, TelegramRuntime>`, per-company digest
   mode becomes expressible again. If the capability is still wanted at that
   point, write a **new** test against the **new** model — a Map with two
   runtime entries, each carrying its own config — rather than restoring the
   deleted one. The old test's assertions were written for a runtime shape
   (`TelegramCompanyRuntime`, `resolveCompanyRuntimes`) that isn't coming
   back (ADR 0005); a same-intent test with a fresh body is the correct
   sequel to the deletion, not a revert of it.

## Consequences

A reader who sees this test deleted in step 03, then later sees
per-company runtimes land in step 04, has one authoritative place to check
whether the deletion was a mistake (it wasn't) or the capability should
return (it can, deliberately, as new test code). A working reference for the
deleted test's timing/dedup logic (`resolveDigestMode`, `parseDigestTime`,
`digestTimesForConfig`, `resolveDigestSlot`) remains on
`origin/prerelease-pre-rebase-backup` (`c36e532`) — adapt it, don't restore
it verbatim, since it was written against the multi-runtime era's runtime
shape, not the one ADR 0005 builds.
