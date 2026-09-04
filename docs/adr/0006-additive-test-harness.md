# ADR 0006: Test harness is additive-only; no sweep of existing mock-ctx files

Date: 2026-09-04
Status: Accepted
Related: GIF-156 (step 05)

## Context

27 of 38 test files define their own `mockCtx()`/`makeCtx()` factory, 23
re-stub `src/telegram-api.js`, and none share a fixture module. Fixtures have
already drifted (`commands.test.ts` defines its `projects.list` mock twice,
the second silently overwriting the first) and raw state-key strings leak
into tests directly — 72 occurrences of `stateStore["sessions_chat-1_42"]`-
style access in the ACP suite alone — so renaming one state key breaks seven
suites at once.

## Decision

Add `tests/harness.ts` and use it only for new tests — everything steps 02
through 08 need. Do not sweep the 27 existing files in this step: PR #92 is
currently mid-edit on 8 of them, and GIF-142 is backfilling upstream tests
against several more; a sweep now would collide with both. Existing files
migrate opportunistically, when a later step that touches them anyway
already has to rewrite them.

## Consequences

This step is sequenced early despite being medium priority because it lowers
the cost of every step after it — steps 02, 03, 04, 06, 07 and 08 all ship
test changes, and paying the 27-way duplication cost across all six is more
expensive than paying it once here. Tradeoff: duplication persists in the
untouched files until something else forces their hand; there is no
scheduled cleanup pass for the remainder.
