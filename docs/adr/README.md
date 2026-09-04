# Architecture decision records

One ADR per decision from the 2026-09-04 architecture review (steps 00–08,
tracked as GIF-149 through GIF-160). Each is self-contained: context,
decision, consequences. See `../architecture-migration.md` for the
single-owner rebase these decisions build on top of, and `../../CONTEXT.md`
for the vocabulary they introduce.

| ADR | Step | Issue | Title |
|---|---|---|---|
| [0001](0001-builtin-commands-drift.md) | 00 | GIF-149 | Patch `BUILTIN_COMMANDS` drift now, not after the command-table rewrite |
| [0002](0002-invocation-scope-reproduce-first.md) | 01 | GIF-151 | Confirm the invocation-scope failure reproduces before patching around it |
| [0003](0003-company-lookup-no-throw.md) | 02 | GIF-152 | Company lookup returns a result, never throws |
| [0004](0004-retire-per-company-digest-test.md) | 03 | GIF-153 | Retire the per-company digest test under single-owner; reintroduce deliberately under multi-runtime |
| [0005](0005-multi-runtime-fresh-design.md) | 04 | GIF-154 | Multi-runtime is a fresh design, not a restoration of the pre-rebase implementation |
| [0006](0006-additive-test-harness.md) | 05 | GIF-156 | Test harness is additive-only; no sweep of existing mock-ctx files |
| [0007](0007-reply-and-overflow-policy.md) | 06 | GIF-155 | Reply construction takes structured parts; overflow policy is caller-declared |
| [0008](0008-config-single-source-of-truth.md) | 07a | GIF-157 | `src/config.ts` becomes the single source of truth for plugin configuration |
| [0009](0009-parked-interactions.md) | 07b | GIF-158 | One module owns parked-interaction keys, codec, liveness, and expiry |
| [0010](0010-one-command-table.md) | 07c | GIF-159 | Command name lists collapse into one table with derived views |
| [0011](0011-transport-adapter.md) | 08 | GIF-160 | Two transports collapse behind a spawn/send/terminate adapter interface |
