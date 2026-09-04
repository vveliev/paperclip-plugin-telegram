# ADR 0011: Two transports collapse behind a spawn/send/terminate adapter interface

Date: 2026-09-04
Status: Accepted
Related: GIF-160 (step 08)

## Context

Two transports exist in effect in `acp-bridge.ts` — native via
`ctx.agents.sessions`/`wakeAgentWithIssue`, and ACP via `ctx.events.emit` —
but not behind an interface. Ten sites re-test the string literal
`transport === "acp"` and hand-write the dispatch; they collapse into three
repeated shapes (spawn-with-native-fallback ×3, deliver-a-message ×4,
terminate-a-session ×2), and the same three-line "host RPC must not
propagate" comment is pasted eight times verbatim. There is no single seam
whose deletion collapses this — removing the `transport` field would require
rewriting all ten sites individually, which is the signature of a scattered
branch rather than a real seam.

## Decision

A narrow [[Transport adapter]] interface — `spawn` / `send` / `terminate` —
with two adapters (native, ACP). Company resolution is delegated to step
02's lookup module (ADR 0003); the load-mutate-save session idiom (8 sites,
3 inline variants) moves to a separate session-store module. Three small,
deep modules rather than one file that knows about transports, companies,
and storage all at once.

## Consequences

A third transport becomes one new adapter, not ten edits. Sequenced last in
the plan because `acp-bridge.ts` is the most contested file in the tree:
gated on PR #92 (rewrites all 13 `events.emit` sites in this file) and
GIF-141 (adds ~409 lines to it) landing first, to avoid rewriting the same
lines twice. The four null writes filed separately as a live defect are in
this file too, but are fixed independently rather than folded into this
step.
