# V1 Modernization Program

Canonical plan: `../../V2_MODERNIZATION_PLAN.md`
Agent rules: `../../AGENTS.md`
Current state: `STATUS.md`
Package ledger: `WORK_PACKAGES.md`

## Resume

1. Run `scripts/modernization/bootstrap-plan.ps1`.
2. Run `scripts/modernization/validate-handoff.ps1`.
3. Read `STATUS.md`, then the active package ledger/evidence.
4. Select only a ready package whose dependencies are accepted.

### If step 1 throws `data/db.json must not exist`

You have not broken anything, and this is not a real runtime database. **Running the mandatory
baseline gate (`npm run test:server`) creates `data/db.json`, `data/backups/*.json`, and `logs/`
in the repository**, and the preflight in step 1 then refuses to pass. The documented FND-001
command sequence therefore cannot be run twice without a cleanup in between.

Confirm the file is the empty default (19 empty collections plus `_schemaVersion`), then:

```powershell
Remove-Item .\data\db.json -Force
Remove-Item .\data\backups -Recurse -Force
```

All of these are untracked and gitignored, so they can never reach a commit. Recorded as DISC-001
in `DECISIONS.md` with four remediation options; **awaiting a user decision, so do not "fix" it
yourself.** Never delete a `data/db.json` that contains real records — check before removing.

## Directories

- `templates/`: immutable templates copied into program/evidence artifacts.
- `evidence/<WP-ID>/`: package commands, results, provenance, verification, rollback.
- `STATUS_ARCHIVE.md`: accepted/closed package history moved out of bounded STATUS.

No commit, remote action, release, deployment, or Tower access without explicit user approval.
