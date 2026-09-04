# FND-005: Isolate the test suite's data root (DISC-001 remediation)

> **Filled in 2026-09-03 (kevin) — this file was an unfilled template despite the package being
> fully accepted.** Content below is transcribed from `SUMMARY.md`, `DIFF_SCOPE.md`, `ROLLBACK.md`,
> `RESULTS.json`, and `docs/modernization/DECISIONS.md` (all of which were filled in correctly at
> the time), not newly invented.

- State: accepted (`STATUS.md` Recent Accepted Packages, SHA `2ae02c4`, 2026-08-22)
- Owner: coordinator
- Worktree: coordinator worktree (no branch)
- Branch: none
- Dependencies: FND-001 (fixes a precondition FND-001's own gate violates)
- Reviewer: independent verifier — `VERIFICATION.md`: **PASS**

## Contract Preserved

All V1 behavior. No production file modified — the two new files are test infrastructure only
(`vitest.config.js`, `server/tests/vitest.globalSetup.mjs`). Nothing under `server/` (outside the
test directory), `client/`, or `data/` changed.

## New Capability

`npm run test:server` no longer writes `data/db.json`, `data/backups/`, or `logs/` into the
repository, so `bootstrap-plan.ps1` stops throwing after a gate run — the documented FND-001
clean-room sequence becomes repeatable.

## Owned Paths

- `vitest.config.js` (new)
- `server/tests/vitest.globalSetup.mjs` (new)
- `docs/modernization/evidence/FND-005/**`
- Coordinator ledgers: `STATUS.md`, `WORK_PACKAGES.md`, `DECISIONS.md`, `RISK_REGISTER.md`

## Explicit Non-Goals

- Not removing the module-load-time `mkdirSync` side effect in `server/database/init.js` — that is
  production code, out of scope for a test-infrastructure package, and the hazard it protects
  (real RCON password / JWT secret material) means it must not be weakened, only isolated around.
- Not an unconditional override: the setup declines to touch a `paths.config.json` that already
  exists, rather than risk clobbering a developer's real data-root override (see RISK-008).

## Hypothesis and Cheapest Falsifier

- Hypothesis: isolating the test run's data root with a temporary `paths.config.json`, written by a
  Vitest `globalSetup` before workers spawn, stops the repo-root artifacts without changing what
  the suite discovers or runs.
- Focused test (two-sided, because a one-sided check would miss the real risk): artifacts absent
  (`db.json`/`backups`/`logs`/`pathsconfig` all `False` pre- and post-run) **and** test count
  unchanged (535/535 across 51 files, identical to the FND-001 baseline).

## Implementation Steps

1. Add a root `vitest.config.js` setting `test.globalSetup` and nothing else, so existing default
   discovery/execution behavior is preserved.
2. Add `server/tests/vitest.globalSetup.mjs`: refuses to run if `paths.config.json` already exists,
   otherwise writes one pointing at a temporary root, and removes it in teardown.

## Required Fault Tests

- Two consecutive `npm run test:server` runs followed immediately by `bootstrap-plan.ps1` must
  return `PASS runtime-db-absent` — the exact sequence that threw before this fix.
- Client suite (90/90, 14 files) must stay unchanged, confirming the new root config does not leak
  into `client/vite.config.ts`.

## Acceptance Gates

- [x] Focused tests — two-sided falsifier held (`SUMMARY.md`, `RESULTS.json`)
- [x] Domain tests — n/a beyond the falsifier itself; this is test-harness behavior, not a runtime
      domain
- [x] V1 parity evidence — no production file modified (`DIFF_SCOPE.md`)
- [x] Full required gate — server 535/535, client 90/90, lint clean, `tsc -b` clean, build
      succeeded, `git diff --check` clean (`RESULTS.json`)
- [x] Independent verification — `VERIFICATION.md`: **PASS**
- [ ] Rollback rehearsal — partially rehearsed only; see `ROLLBACK.md` ("the useful half was
      rehearsed for real" — the pre-rollback state was observed live during FND-001, but the
      removal commands themselves were deliberately not executed against a tree other agents were
      using)

## Evidence

- `docs/modernization/evidence/FND-005/SUMMARY.md`
- `docs/modernization/evidence/FND-005/RESULTS.json`
- `docs/modernization/evidence/FND-005/DIFF_SCOPE.md`
- `docs/modernization/evidence/FND-005/ROLLBACK.md`
- `docs/modernization/evidence/FND-005/VERIFICATION.md`

## Rollback

```powershell
Remove-Item .\vitest.config.js -Force
Remove-Item .\server\tests\vitest.globalSetup.mjs -Force
```

No git operation — nothing was staged or committed at package time. Verification that the old
(defective) behavior is back: `npm run test:server`, then confirm `data/db.json` exists again and
`bootstrap-plan.ps1` throws. The defect reappearing **is** the proof of a successful rollback. Full
detail, including why the removal itself was not executed during this package's own rehearsal, is
in `ROLLBACK.md`.

## Risks / Decisions

- Risk IDs: resolves DISC-001 / RISK-006; introduces RISK-008 (accepted); surfaced DISC-002 /
  RISK-007 while checking this package's own scope (not this package's defect — see
  `evidence/FND-006/`, which fixed it)
- ADR IDs: none — DISC-001 is a plan discrepancy, not an architectural decision
