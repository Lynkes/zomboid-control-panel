# Evidence Summary: FND-005

- Work package: FND-005 — Isolate the test suite's data root (DISC-001 remediation)
- Owner: coordinator
- Reviewer: pending independent verification
- Base SHA: `e966fe94c7d6aca60986c7704a80e576bc1fa9f3`
- Candidate SHA/diff hash: none — uncommitted working tree
- State: review

## Contract

- **Preserved V1 behavior:** all of it. **No production file was modified.** The two new files are
  test infrastructure: a root `vitest.config.js` and `server/tests/vitest.globalSetup.mjs`. Nothing
  under `server/` (except the test directory), `client/`, or `data/` changed.
- **New capability:** `npm run test:server` no longer writes `data/db.json`, `data/backups/`, or
  `logs/` into the repository, so `bootstrap-plan.ps1` stops throwing after a gate run.
- **Feature flag/default:** none. This is test-harness behavior, not runtime behavior.

## Why the fix has this shape

Two constraints, both discovered by reading rather than assuming:

1. **`getDataPaths()` (`server/utils/paths.js:30`) has no environment override** and **memoizes
   into a module-level `currentPaths`**. The override must exist on disk *before the first import*.
   `globalSetup` runs in the main process before workers spawn — `setupFiles` would be too late.
2. **There was no server-side vitest config at all.** `test:server` ran on stock defaults, so the
   fix had to *create* a root config.

## Results

- **Falsifier (two-sided, because a one-sided one would have missed the real risk):** the obvious
  check is "do the stray files stop appearing?" But introducing a root config where none existed
  can silently change **test discovery**, which would be a worse regression than the defect. So the
  check was both: artifacts absent **and** count unchanged.
  - Before: `PRE: db.json=False backups=False logs=False pathsconfig=False`
  - After: `POST: db.json=False backups=False logs=False pathsconfig=False`
  - **Tests: 535 passed (535), Test Files: 51 passed (51)** — identical to the FND-001 baseline.
- **The actual proof the defect is closed:** a **second consecutive** `npm run test:server`
  followed immediately by `bootstrap-plan.ps1` returns `PASS runtime-db-absent`, exit 0. That exact
  sequence threw before FND-005. The documented FND-001 sequence is now repeatable.
- **Full gate:** server 535/535, client 90/90 across 14 files, `lint:server --max-warnings=0`
  clean, `tsc -b` no diagnostics, `npm run build` succeeded, `git diff --check` clean.
- **Client isolation confirmed:** the client suite is unchanged at 90/90, so the new root config
  does not leak into the client project (which resolves its own `client/vite.config.ts`).

Machine results: `RESULTS.json`, schema-valid.

## Security / Secrets

No secret surface. The setup writes a JSON file containing two temporary directory paths and
nothing else. It never reads, copies, or logs database contents.

**One safety property worth stating explicitly:** the setup **refuses to touch an existing
`paths.config.json`**. A developer may be pointing the panel at a real data root, and silently
replacing that file would be materially worse than the defect being fixed. The consequence —
isolation is conditional, not absolute — is recorded as RISK-008 and accepted, and the setup logs
which branch it took so the condition is observable rather than silent.

## Provenance

No V2 code or concept was ported. The pattern is lifted from the plan's own performance-baseline
step, which already writes a temporary `paths.config.json`; this generalizes it to the test gate.

## Risks and Decisions

- Resolves: DISC-001, RISK-006
- Introduces: RISK-008 (conditional isolation, accepted)
- Surfaced while verifying scope: **DISC-002 / RISK-007 (critical)** — see below
- ADRs: none

## DISC-002, found while checking this package's own scope

Running the plan's documented owned-path check on FND-005 returned `FAIL ... UNOWNED
vitest.config.js`. The cause was not an ownership violation. **`pwsh -File` binds
`-AllowedPath a,b` as a single string**, so every allowed path is silently discarded — proven
directly (`elements=1`, `["a,b,c"]`).

FND-001's check had returned `PASS` only because its paths coincide with the script's hardcoded
`$initialHandoff` fallback; **the argument was never evaluated there either.** FND-005 is simply
the first package to own a path outside that fallback, and therefore the first to get a wrong
answer from a guard with a history of passing.

Re-run with a genuine array: `PASS work-package=FND-005 changed=12`. Recorded as DISC-002 /
RISK-007, awaiting a user decision; neither the plan text nor the script has been changed.

## Rollback

Delete the two new files. No git operation — nothing committed.

```powershell
Remove-Item .\vitest.config.js -Force
Remove-Item .\server\tests\vitest.globalSetup.mjs -Force
```

Verification that the pre-FND-005 behavior is back: run `npm run test:server`, then confirm
`data/db.json` exists again and `bootstrap-plan.ps1` throws. The reappearance of the defect **is**
the proof of a successful rollback.

## Recommendation

**ACCEPT**, subject to independent verification.

The contract was met with no production change, the two-sided falsifier held, the full gate is
green, and the defect is demonstrably closed by the repeatability proof rather than by assertion.
