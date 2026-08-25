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

## Directories

- `templates/`: immutable templates copied into program/evidence artifacts.
- `evidence/<WP-ID>/`: package commands, results, provenance, verification, rollback.
- `STATUS_ARCHIVE.md`: accepted/closed package history moved out of bounded STATUS.

No commit, remote action, release, deployment, or Tower access without explicit user approval.
