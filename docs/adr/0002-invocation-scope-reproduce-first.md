# ADR 0002: Confirm the invocation-scope failure reproduces before patching around it

Date: 2026-09-04
Status: Accepted (procedural)
Related: GIF-151 (step 01), upstream issue #104

## Context

Upstream issue #104 reports `/connect <name>` failing with `Plugin is not
allowed to perform "companies.list": the worker referenced a missing,
expired, or unknown invocation scope`, because the SDK runs each host-issued
invocation inside an `AsyncLocalStorage` and stamps outgoing requests with
the current invocation id. `pollUpdates` is started from inside
`onConfigChanged`, so the loop inherits that invocation's id for the life of
the worker; once the invocation completes, every call the loop makes is
rejected as an expired scope.

Our tree has the same shape: no `AsyncLocalStorage` handling anywhere in
`src/`, and `pollUpdates(ctx)` is started inside `bootstrapRuntime`, called
from `onConfigChanged` via `queueBootstrap` — verified 2026-09-04 on
`prerelease`.

The pre-rebase implementation had already met and defended against this
exact failure class. Its comment in `resolveCompanyRuntimes` cites
`paperclipai/paperclip#9368` and `#11163`, and that defense was lost in the
single-owner rebase (see `docs/architecture-migration.md`).

## Decision

Establish whether the failure actually reproduces against the currently
running host version before writing a fix — via `/connect` and `/status` —
rather than porting the old defense speculatively. If it reproduces, start
the loop inside a blank `AsyncLocalStorage` snapshot captured at module
load, per upstream's verified fix. If it doesn't, record what was checked
and its output, and park the fix rather than shipping unneeded complexity.

## Consequences

This step gates step 04 / ADR 0005 (multi-runtime): a fix built on an
unconfirmed premise would ship speculative complexity into a rewrite that's
already large. Whichever outcome (confirmed or ruled out) must be recorded
with the command run and its output — a plausible-looking silent skip is not
an acceptable resolution here.
