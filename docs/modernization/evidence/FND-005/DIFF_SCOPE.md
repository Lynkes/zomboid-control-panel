# Diff Scope: FND-005

- Base SHA: `e966fe94c7d6aca60986c7704a80e576bc1fa9f3`
- Candidate SHA/diff hash: none — uncommitted working tree

## Declared Ownership

- `vitest.config.js` (new)
- `server/tests/vitest.globalSetup.mjs` (new)
- `docs/modernization/evidence/FND-005/**`
- Coordinator ledgers: `STATUS.md`, `WORK_PACKAGES.md`, `DECISIONS.md`, `RISK_REGISTER.md`

## Actual Changed Paths

| Path | Change type | Why required | Owner-approved |
| --- | --- | --- | --- |
| `vitest.config.js` | added | No server-side vitest config existed; `globalSetup` has nowhere else to live | Yes |
| `server/tests/vitest.globalSetup.mjs` | added | Writes the temporary `paths.config.json` before workers spawn | Yes |
| `docs/modernization/evidence/FND-005/**` | added | Package evidence | Yes |
| `docs/modernization/DECISIONS.md` | modified | DISC-001 resolved; DISC-002 recorded | Yes — coordinator ledger |
| `docs/modernization/RISK_REGISTER.md` | modified | RISK-001 diagnosed, 005/006 resolved, 007/008 added | Yes — coordinator ledger |
| `docs/modernization/STATUS.md` | modified | Checkpoint SHA, decisions, current state | Yes — coordinator ledger |

**No production file was modified.** Nothing under `client/`, `data/`, or `server/` outside the
test directory. Confirmed by `git status --porcelain`.

## Coordinator-Owned Hunks

| File | Symbol/section | Patch purpose | Integration order |
| --- | --- | --- | --- |
| _none_ | — | FND-005 adds no hunk to any existing source file; both code changes are new files | n/a |

## Generated / Runtime Files

None. Actively verified absent after the gate: `data/db.json`, `data/backups/`, `logs/`, and
`paths.config.json` — the last of these because the setup's teardown removes what it created.
That absence is the package's whole point, so it is an acceptance criterion, not just hygiene.

## Scope Verdict

**PASS** — with an important caveat about how that verdict was obtained.

The plan's documented invocation returned `FAIL ... UNOWNED vitest.config.js`. That was **not** an
ownership violation: `pwsh -File` binds `-AllowedPath a,b` as one string, silently discarding every
allowed path (see DISC-002 / RISK-007). Re-run with a real array:

```
PASS work-package=FND-005 changed=12
```

Recording both outcomes deliberately. A reader who saw only the PASS would not learn that the
documented command is broken, and that is the more valuable of the two findings.
