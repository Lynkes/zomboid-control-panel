# FND-001: Fork baseline, program ledgers, and evidence structure

> **Filled in 2026-09-03 (kevin) — this file was an unfilled template, missed in my first FND-001
> reconciliation pass (I edited the Acceptance Gates section below without scrolling up to see the
> header was blank too). Caught during the follow-up docs/** placeholder sweep. Content transcribed
> from `SUMMARY.md`, `DIFF_SCOPE.md`, `ROLLBACK.md`, `STATUS.md`, `RISK_REGISTER.md`, and
> `WORK_PACKAGES.md` (which already correctly lists this package as accepted) — nothing invented.**

- State: accepted (`WORK_PACKAGES.md`, `STATUS.md` Recent Accepted Packages — SHA `e966fe9`, 2026-08-22)
- Owner: coordinator
- Worktree: coordinator worktree (no branch)
- Branch: none
- Dependencies: none — FND-001 is the dependency-graph root
- Reviewer: independent verifier — `VERIFICATION.md` round 2: **PASS**

## Contract Preserved

All V1 behavior. No file under `server/`, `client/`, `data/`, or any other tracked path was
created, modified, or deleted — `git status --porcelain` reports zero tracked modifications after
the complete gate.

## New Capability

Documentation and evidence only: 8 program ledgers, 10 FND-001 evidence artifacts, a recorded
toolchain, a performance sample, and the API/DB inventory starting point. The seven `MODERN_*`
feature flags are recorded as all-false in `RESULTS.json` to document intent; no flag or default
was actually introduced (`FND-004` owns the real registry).

## Owned Paths

- `docs/modernization/{README,STATUS,STATUS_ARCHIVE,WORK_PACKAGES,DECISIONS,RISK_REGISTER,BASELINE,ROLLBACK}.md`
- `docs/modernization/evidence/FND-001/**`
- `scripts/modernization/**`

## Explicit Non-Goals

- Not creating or editing `API_CONTRACT_INVENTORY.md` (FND-002), `DATA_MAPPING.md` (DB-001),
  `CAPABILITY_MATRIX.md` (AGT-001), `THREAT_MODEL.md` (AUT-001), `server/modern-src/**`, or
  `tsconfig.modern.json` (FND-003) — the plan states FND-001 must not touch those packages'
  artifacts.

## Hypothesis and Cheapest Falsifier

- Hypothesis: the fork at `8642dc4` (`v1.1.55`) is green and reproducible without modification.
- Focused test: `npm ci` in both trees, then `git diff --exit-code -- package-lock.json
  client/package-lock.json`. Exit 0 — lockfiles byte-identical. Not disproven.

## Implementation Steps

1. Confirm baseline identity (SHA, tag, remote state) and capture it in `BASELINE.md`.
2. Author the 8 program ledgers (`README`, `STATUS`, `STATUS_ARCHIVE`, `WORK_PACKAGES`,
   `DECISIONS`, `RISK_REGISTER`, `BASELINE`, `ROLLBACK`).
3. Recount the V1 API/DB surface (route files, router mounts, route handlers, socket events,
   `defaultData` collections) as the inventory starting point.
4. Capture the toolchain (`runtime.json`) and a single-route performance baseline (`PERF.json`),
   isolating the perf server's data root via a temporary `paths.config.json` removed in `finally`.
5. Author this package's own evidence set (`SUMMARY`, `DIFF_SCOPE`, `ROLLBACK`, `PROVENANCE`,
   `COMMANDS`, `RESULTS.json`).

## Required Fault Tests

- n/a — there is no failure path to inject into a documentation-only package. The nearest
  equivalent, exercised for real: the perf run's `finally` cleanup was verified to have removed
  `paths.config.json` and both temporary roots it created.

## Acceptance Gates

- [x] Focused tests — falsifier run, not disproven (`SUMMARY.md`)
- [ ] Domain tests — n/a, FND-001 owns no runtime domain (`SUMMARY.md`)
- [x] V1 parity evidence — `git status --porcelain` clean of tracked entries (`SUMMARY.md`, `VERIFICATION.md`)
- [x] Full required gate — passed (`SUMMARY.md`)
- [x] Independent verification — `VERIFICATION.md` round 2, 2026-08-22: **PASS**
- [ ] Rollback rehearsal — deliberately not performed; running it would delete the evidence under review (`ROLLBACK.md`)

> **Reconciled 2026-09-03 (kevin):** this checklist was left entirely unchecked despite every
> outcome already being on record elsewhere in this package. Boxes above now match what
> `SUMMARY.md`/`VERIFICATION.md` actually say; the two still unchecked are correctly unchecked
> (n/a and deliberately-skipped, not incomplete work).

## Evidence

- `docs/modernization/evidence/FND-001/SUMMARY.md`
- `docs/modernization/evidence/FND-001/DIFF_SCOPE.md`
- `docs/modernization/evidence/FND-001/ROLLBACK.md`
- `docs/modernization/evidence/FND-001/PROVENANCE.md`
- `docs/modernization/evidence/FND-001/COMMANDS.md`
- `docs/modernization/evidence/FND-001/RESULTS.json`, `PERF.json`, `runtime.json`
- `docs/modernization/evidence/FND-001/VERIFICATION.md`

## Rollback

Deletes only the 18 files this package authored (10 evidence artifacts + 8 program ledgers) — no
git operation, because nothing was staged or committed at package time. Rehearsal deliberately not
performed (running it would delete the evidence under review); its preconditions are verified and
the success signal is observable (`bootstrap-plan.ps1` flips from `mode=resume` back to
`mode=baseline`). Full command list and reasoning in `ROLLBACK.md`.

## Risks / Decisions

- Risk IDs: RISK-001 (high, cold-run flake), RISK-002 (high, `db.example.json` stale — since
  independently found resolved, not yet reflected in `RISK_REGISTER.md`), RISK-003 (high,
  single-route perf coverage), RISK-004 (medium, unmeasured bundle size at package time), RISK-005
  (medium, worktrees blocked until checkpoint — resolved same day); DISC-001 / RISK-006 (found here,
  resolved by FND-005)
- ADR IDs: none. FND-001 recorded state rather than deciding architecture; the first ADRs belong to
  `DB-001` (`ADR-DB-001`) and `AUT-001` (`ADR-AUTH-001`).
