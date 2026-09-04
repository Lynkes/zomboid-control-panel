# Rollback Manifest: FND-006

> **Filled in 2026-09-03 (kevin) — this file was an unfilled template.** Content transcribed from
> `SUMMARY.md`'s own Rollback section (already correct there) and `WORK_PACKAGE.md`.

- Feature flag: none — toolkit-script behavior, not a runtime feature
- Pre-change SHA: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`)
- Candidate SHA: `8f4ec5f249b36ffe9ede5e4a18aca5a2561b8fdc`
- Data authority before: n/a — no production data path touched
- Data authority after: **unchanged**

## Backups

| Artifact | Backup path | SHA-256 | Restore target | Verified |
| --- | --- | --- | --- | --- |
| _none required_ | — | — | — | — |

Both changed files existed before this package; the change is an in-place edit, not a new file, so
`git checkout --` is a complete restore with no separate backup needed.

## File Rollback

```powershell
git checkout -- scripts/modernization/check-owned-paths.ps1 V2_MODERNIZATION_PLAN.md
```

Verification that the old (defective) behavior is back:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernization\check-owned-paths.ps1 -Id X -AllowedPath " , , "
# Before FND-006: returns exit 0 (silently accepted). After a successful rollback: exit 0 again.
# The defect (a guard that cannot fail) reappearing IS the proof of a successful rollback.
```

## Data Rollback Rule

Preserve, never delete. No modern database exists; this package touches no data path at all.

## Post-Rollback Verification

- [x] V1 workflow smoke test — full gate was green on this exact tree before commit (`RESULTS.json`)
- [x] Data authority confirmed — n/a, no data path touched
- [x] Evidence captured — `RESULTS.json`, `SUMMARY.md`
- [ ] Rollback commands executed — not exercised; per `SUMMARY.md`'s own reasoning for the sibling
      FND-001/FND-005 packages, running it would reintroduce a known, real defect (the
      argument-binding bug) into a tree other packages/agents depend on
