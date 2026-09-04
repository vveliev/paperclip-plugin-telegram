# ADR 0009: One module owns parked-interaction keys, codec, liveness, and expiry

Date: 2026-09-04
Status: Accepted
Related: GIF-158 (step 07b), upstream issue #103

## Context

Telegram updates are strictly sequential, so a handler cannot await a
button press; every interactive flow parks state and resumes in the callback
handler instead. Six flows do this with six independent implementations —
`ask_user_questions`, `wait_approval`, `escalation`, `handoff`, approval
notice, and decisions paging — each with its own `callback_data` format, its
own parsing idiom (`lastIndexOf`, `slice`, `split`+`join`, or `replace`), and
its own liveness sentinel (not-found, a `resolved:true` flag, a
`status!=pending` check, or none at all). Only `ask_user_questions` ever
reclaims its row via delete; the rest never clean up.

Upstream issue #103 independently confirms the `wait_approval` half of this
— "no expiry, no pending-key index, no cleanup job, and no delete path…
`plugin_state` grows monotonically" — and confirms a real delete path exists
(`ctx.state.delete`, proven working by `interaction-answers.ts:139`); the
NOT-NULL constraint blocks only the null-assignment workaround some flows
use instead of deleting. An unanswered `wait_approval` currently hangs a
workflow silently forever; `escalation` is the only flow with a timeout job
at all. The same underlying plumbing has broken twice for reasons unrelated
to its own per-flow logic — the BLA-606 incident and again during the
single-owner migration — which is evidence the seam itself, not any one
flow, is the problem.

## Decision

One module owns key allocation, encode/decode within Telegram's 64-byte
`callback_data` cap, a single liveness rule, and expiry — TTL and a sweeper
are part of the interface, not left to each flow to remember. This is not a
codec-only change: flows that currently never expire (`wait_approval`,
`escalation`, `handoff`) gain a TTL they don't have today.

## Consequences

All six flows migrate to one [[Parked interaction]] shape. Upstream #103
becomes answerable. The four null writes in `acp-bridge.ts` (same family of
bug, filed separately as a live defect) are related but out of scope here.
Gated on PR #92 (`escalation.ts`) and #96 (`command-registry.ts`).
