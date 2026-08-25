# Rollback Manifest: FND-005

- Feature flag: none — test-harness behavior, not runtime behavior
- Pre-change SHA: `e966fe94c7d6aca60986c7704a80e576bc1fa9f3`
- Candidate SHA: none — uncommitted
- Data authority before: V1 `data/db.json` via lowdb
- Data authority after: **unchanged**

## Backups

| Artifact | Backup path | SHA-256 | Restore target | Verified |
| --- | --- | --- | --- | --- |
| _none required_ | — | — | — | — |

No existing file was modified, so there is nothing to restore. Both code changes are new files.

## File Rollback

```powershell
Set-Location 'D:\Projects\Zomboid_Control_Panel_Modernized'
Remove-Item .\vitest.config.js -Force
Remove-Item .\server\tests\vitest.globalSetup.mjs -Force
```

No git operation: nothing was staged or committed.

## Post-Rollback Verification

The defect returning **is** the proof the rollback worked:

```powershell
npm run test:server
Test-Path .\data\db.json        # expect True again
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernization\bootstrap-plan.ps1
# expect the throw: data/db.json must not exist in the modernization fork baseline.
```

Then clean up so the tree is not left failing its own preflight:

```powershell
Remove-Item .\data\db.json -Force
Remove-Item .\data\backups -Recurse -Force
```

## Data Rollback Rule

Preserve, never delete. No modern database exists. The only files this package causes to be written
live under a temporary root and are removed in teardown.

## Rehearsal Result

**Partially rehearsed, and the useful half was rehearsed for real.** The *pre*-rollback state was
observed directly during FND-001: the gate produced `data/db.json` and the preflight threw, twice,
independently (coordinator and verifier). So the behavior this rollback restores is not theoretical.

The removal commands themselves were not executed, because doing so would reintroduce a known
defect into a tree other agents are working in. Both commands are literal and the success signal is
observable rather than asserted.

- [x] Data authority confirmed — lowdb/`data/db.json`, unchanged
- [x] V1 workflow smoke test — full gate green on this exact tree
- [x] Evidence captured — `RESULTS.json`
- [ ] Removal commands executed — deliberately not, see above
