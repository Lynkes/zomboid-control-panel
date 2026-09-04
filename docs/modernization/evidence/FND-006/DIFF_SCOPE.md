# Diff Scope: FND-006

> **Filled in 2026-09-03 (kevin) — this file was an unfilled template.** Content below is
> transcribed from `SUMMARY.md`, `WORK_PACKAGE.md`, `RESULTS.json`, and `git show --stat
> 8f4ec5f2` (the real commit this package's changes were folded into, landed the same day as
> FND-007's) — not newly invented. This package's changes were uncommitted working-tree edits at
> evidence-capture time; `RESULTS.json`'s own `git_sha` field wrongly recorded a zero-padded
> non-SHA (`f9c4619000...`) instead of a real commit hash, corrected in the same reconciliation
> pass as this fill-in — see the `SUMMARY.md` status note.

- Base SHA: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`, per `RESULTS.json.baseline_sha`)
- Candidate SHA/diff hash: `8f4ec5f249b36ffe9ede5e4a18aca5a2561b8fdc` (landed together with FND-007
  in one commit — "modernization: FND-006 harden owned-path guard; FND-007 fix RISK-001; withdraw
  DISC-002b", 2026-08-22)

## Declared Ownership

- `scripts/modernization/check-owned-paths.ps1`
- `V2_MODERNIZATION_PLAN.md` (a single explanatory note beside the documented command)
- `docs/modernization/evidence/FND-006/**`

## Actual Changed Paths

Per `git show --stat 8f4ec5f2` (shared commit with FND-007 — table below lists only this package's
own files; FND-007's are in its own `DIFF_SCOPE.md`):

| Path | Change type | Why required | Owner-approved |
| --- | --- | --- | --- |
| `scripts/modernization/check-owned-paths.ps1` | modified | split `-AllowedPath` on commas, throw on an argument yielding no usable entries | Yes |
| `V2_MODERNIZATION_PLAN.md` | modified | explanatory note beside the documented invocation, warning against removing the split | Yes |
| `docs/modernization/WORK_PACKAGES.md` | modified | ledger entry | Yes — coordinator ledger |
| `docs/modernization/evidence/FND-006/**` | added | package evidence | Yes |

**No production file touched** — confirmed by `SUMMARY.md`'s own contract statement and by this
being a toolkit-script + documentation-only change.

## Coordinator-Owned Hunks

| File | Symbol/section | Patch purpose | Integration order |
| --- | --- | --- | --- |
| `scripts/modernization/check-owned-paths.ps1` | `-AllowedPath` binding | split on commas + refuse-empty guard | n/a — single-commit package |

## Generated / Runtime Files

None. `RESULTS.json` records a self-inflicted `git diff --check` failure (CRLF from a scripted
Python edit corrupting `DECISIONS.md`'s line endings), repaired before this package's own gate
passed — not a generated/runtime artifact, a transient authoring mistake, already disclosed in
`SUMMARY.md`.

## Scope Verdict

**PASS**

`check-owned-paths.ps1 -Id FND-006 -AllowedPath scripts/modernization/,docs/modernization/`
returned `PASS work-package=FND-006 changed=3`, exit 0 (`RESULTS.json`). Unlike FND-001's identical-
looking invocation, this one genuinely evaluates the argument — this is the package that fixed the
comma-binding bug (DISC-002), so its own scope-check output can be trusted at face value.
