# ADR 0003: Company lookup returns a result, never throws

Date: 2026-09-04
Status: Accepted
Related: GIF-152 (step 02)

## Context

Three independent implementations resolve `chat_<chatId>` state to the same
`{ companyId, companyName }` shape, with three different failure policies:
`commands.ts` throws; `worker.ts` throws and wraps the throw in
`resolveCompanyIdOrNull` to catch it; `acp-bridge.ts` returns `null` (with a
`companyName` fallback) at five separate call sites, each with its own
null-handling branch.

`worker.ts` documents why the throwing variant is dangerous: a throw
escaping `handleUpdate` stops the polling offset from advancing, so Telegram
redelivers the same update forever and the poller wedges for every chat, not
just the one that failed to resolve. `resolveCompanyIdOrNull` exists purely
to defend against a hazard the throwing variant itself created.

## Decision

One module owns the `chat_` key, its value shape, and the lookup. It returns
linked/not-linked and never throws; no throwing variant survives migration.
`commands.ts` call sites that relied on the throw for control flow — each
with its own catch producing a distinct "not linked" message — become
explicit branches on the result. Keep the existing user-facing strings
unless there's a specific reason to unify them, and say so if a string does
change.

## Consequences

The wedge-the-poller failure becomes unrepresentable rather than defended
against, and `resolveCompanyIdOrNull` is deleted along with the throwing
variants it was guarding against. This is a prerequisite for step 04 / ADR
0005: the per-company runtime `Map` must not be built on top of three
competing lookups. Migration of `worker.ts` call sites is gated on PR #97,
which also touches that file.
