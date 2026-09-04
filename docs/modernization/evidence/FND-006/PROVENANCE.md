# V2 Source Provenance: FND-006

> **Filled in 2026-09-03 (kevin) — this file was an unfilled template.** Nil-return content below
> follows the same pattern `FND-001/PROVENANCE.md` and `FND-005/PROVENANCE.md` established, since
> this package is the same shape: a program toolkit script fix, not a port of anything.

- V2 source repository: `D:\Projects\Zomboid_dev_panel V2`
- V2 source commit: **not applicable — no V2 source was read, copied, or adapted**
- V1 fork baseline: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`)

| V2 source path | Symbols/concepts used | Modernization target path | Ported/copied/adapted | Deliberate deviations | Tests |
| --- | --- | --- | --- | --- | --- |
| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |

**Nil return, stated explicitly** so that "no provenance" is distinguishable later from "provenance
not recorded" — this package fixes a PowerShell argument-binding bug in a program toolkit script;
nothing in it originates from, or was compared against, V2 source.

## Dependency/License Review

- Existing project license compatibility: n/a — no dependency change
- New dependencies: **none**
- Notices required: none

## Clean-Room Boundary

Confirmed. `scripts/modernization/check-owned-paths.ps1` is a pre-existing, program-owned toolkit
script; the fix modifies its own argument-parsing logic in place and imports nothing from the V2
filesystem or `D:\Zomboid_dev_panel\GitHub`.
