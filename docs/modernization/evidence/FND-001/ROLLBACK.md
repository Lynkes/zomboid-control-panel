# Rollback Manifest: FND-001

- Feature flag: **none.** FND-001 introduces no runtime behavior, so there is nothing to flag off.
- Pre-change SHA: `8642dc467938a47ca8aac76fc44fc1875446c88b`
- Candidate SHA: **none — no commit was created**
- Data authority before: V1 `data/db.json` via lowdb (file absent in this fork)
- Data authority after: **unchanged** — V1 `data/db.json` via lowdb

## Backups

| Artifact | Backup path | SHA-256 | Restore target | Verified |
| --- | --- | --- | --- | --- |
| _none required_ | — | — | — | — |

No backup was required because no existing file was modified, overwritten, or deleted. The
rollback surface is limited to deleting files that FND-001 created.

## Immediate Flag Rollback

Not applicable — no feature flag was introduced. The seven `MODERN_*` flags named in the plan
remain unimplemented; `FND-004` owns the registry. Recorded in `RESULTS.json.feature_flags` as
all-false to document intent, not because any switch exists.

## File/Binary Rollback

Removes only the 18 files FND-001 authored. Leaves the 37 pre-existing handoff/toolkit files
intact, because deleting those would destroy the program brief itself.

```powershell
$Root = 'D:\Projects\Zomboid_Control_Panel_Modernized'
Set-Location $Root

Remove-Item -Recurse -Force .\docs\modernization\evidence\FND-001
Remove-Item -Force .\docs\modernization\README.md,
                   .\docs\modernization\STATUS.md,
                   .\docs\modernization\STATUS_ARCHIVE.md,
                   .\docs\modernization\WORK_PACKAGES.md,
                   .\docs\modernization\DECISIONS.md,
                   .\docs\modernization\RISK_REGISTER.md,
                   .\docs\modernization\BASELINE.md,
                   .\docs\modernization\ROLLBACK.md
```

No `git` operation is involved. Nothing was staged, committed, branched, or tagged, so there is no
history to rewrite and no reflog entry to recover.

Verification that the legacy (baseline) state is active:

```powershell
git -C $Root status --porcelain          # expect only the 37 handoff entries
git -C $Root diff --exit-code            # expect exit 0
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernization\bootstrap-plan.ps1
# expect RESULT=PASS and mode=baseline (not resume, since STATUS.md is gone)
```

The `mode=baseline` flip is the positive proof: the resume path only reports `mode=resume` when
`STATUS.md` exists, so a successful rollback is observable rather than merely asserted.

## Data Rollback Rule

**Preserve, never delete.** No modern database exists. `data/db.json` was never created, read, or
written — `bootstrap-plan.ps1` asserts `runtime-db-absent` both before and after the package.

The only file written outside the repository during FND-001 was the isolated performance run's
temporary state under `%TEMP%`, together with a temporary `paths.config.json` at the repo root.
Both were removed in a `finally` block and their absence re-verified in the same command
(`CLEANUP_DONE pathConfig_exists=False data_exists=False`).

## Rehearsal Result

**Not rehearsed, and deliberately so.** Executing the removal would delete the very evidence this
package must submit for review. The procedure is nonetheless executable rather than described:
every path above is literal, and the two verification commands produce a checkable state change.

The honest statement is therefore: *the rollback is written and its preconditions are verified, but
it has not been run.* The first genuine rollback rehearsal belongs to a package that changes
runtime behavior, where the risk it mitigates is real.

## Post-Rollback Verification

- [ ] Health endpoint — n/a, no service change
- [x] V1 workflow smoke test — the complete V1 gate already passed against this exact tree state
- [x] Data authority confirmed — lowdb/`data/db.json`, unchanged; runtime DB still absent
- [x] No in-flight operations stranded — no operation model exists yet
- [x] Evidence captured — `RESULTS.json`, `PERF.json`, `runtime.json`, `COMMANDS.md`
