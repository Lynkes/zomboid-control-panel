# Independent Verification: FND-005

- Verifier: Kevin (independent hive agent, kevin-mt4dpz5y)
- Verification date: 2026-08-22
- Candidate branch/worktree: `main` working tree at `D:\Projects\Zomboid_Control_Panel_Modernized`, uncommitted (no separate worktree exists for FND-005 — it was implemented directly in the coordinator's shared tree on top of checkpoint `e966fe9`; see Findings)
- Candidate SHA/diff hash: base `e966fe94c7d6aca60986c7704a80e576bc1fa9f3`; no candidate commit exists (uncommitted, as expected pre-acceptance)
- Independence statement: I did not implement this work package. I read `RESULTS.json`/`SUMMARY.md` only after independently reproducing the defect-closure proof and the DISC-002 argument-binding bug myself; every claim below was re-derived, not accepted on the coordinator's word.

## Contract Review

- Preserved V1 behavior: confirmed. No production/runtime file changed. The only new files are `vitest.config.js` (repo root) and `server/tests/vitest.globalSetup.mjs` — both test infrastructure.
- New behavior: `npm run test:server` no longer writes `data/db.json`, `data/backups/*.json`, or `logs/` into the repository when no `paths.config.json` override is already present. Verified directly, twice, with a repeatability proof (see below).
- Diff scope matches ownership: yes, when the tool is invoked correctly (see DISC-002 in Findings — the documented `-File ... -AllowedPath a,b` invocation form cannot be trusted for this and gives a false negative).

## Re-executed Commands

| Command | Exit | Result/evidence |
| --- | ---: | --- |
| `git rev-parse HEAD` | 0 | `e966fe94c7d6aca60986c7704a80e576bc1fa9f3` — matches the claimed checkpoint |
| `git status --porcelain` (before any gate run) | 0 | 4 tracked-modified ledgers (`DECISIONS.md`, `RISK_REGISTER.md`, `STATUS.md`, `WORK_PACKAGES.md`) + 3 untracked entries (`docs/modernization/evidence/FND-005/`, `server/tests/vitest.globalSetup.mjs`, `vitest.config.js`); nothing under `server/routes|services|database` or `client/` touched |
| State check before any gate run: `data/`, `paths.config.json`, `logs/` | n/a | `data/` contains only `.gitkeep` and `db.example.json`; no `db.json`, no `backups/`; `paths.config.json` absent; `logs/` absent — clean starting state |
| `pwsh ... bootstrap-plan.ps1` (direct exit code, before any gate run) | 0 | `PASS runtime-db-absent / RESULT=PASS` |
| `npm run test:server` (run 1 of 2, direct in this shell, no pre-existing `paths.config.json`) | 0 | **Test Files 51 passed (51). Tests 535 passed (535).** Duration 4.45s (import 27.65s). Exact same 535/51 as the FND-001 baseline — test discovery unchanged |
| State check after run 1: `data/db.json`, `data/backups/`, `paths.config.json`, `logs/` | n/a | All absent. Isolation held and self-cleaned |
| `npm run test:server` (run 2 of 2, immediately after run 1 — the repeatability proof) | 0 | **Test Files 51 passed (51). Tests 535 passed (535).** Duration 4.36s (import 26.38s) |
| State check after run 2 | n/a | `data/db.json`, `data/backups/`, `paths.config.json` all still absent |
| `pwsh ... bootstrap-plan.ps1` (direct exit code, immediately after run 2 — the actual defect-closure proof) | **0** | `PASS runtime-db-absent / RESULT=PASS` — before FND-005 I confirmed this same sequence threw exit 1 with `data/db.json must not exist in the modernization fork baseline.` It does not throw now, twice in a row |
| `npm run lint:server` | 0 | `eslint server eslint-rules --max-warnings=0`, no findings — covers the new `vitest.globalSetup.mjs` |
| `npx vitest run` (in `client/`) | 0 | Test Files 14 passed (14). Tests 90 passed (90) — unchanged from FND-001 baseline. The root `vitest.config.js` does not leak into the client project |
| `check-owned-paths.ps1 -Id FND-005 -AllowedPath docs/modernization/evidence/FND-005/,vitest.config.js,server/tests/vitest.globalSetup.mjs` (documented `-File` form) | 1 | **FAIL** — reproduces DISC-002 exactly as the coordinator reported |
| `check-owned-paths.ps1 -Id FND-005 -AllowedPath @('vitest.config.js','server/tests/vitest.globalSetup.mjs','docs/modernization/evidence/FND-005/')` (corrected `-Command`/array-literal form) | 0 | `PASS work-package=FND-005 changed=14` |
| DISC-002 direct proof (own repro, before reading `SUMMARY.md`'s account): `pwsh -File argtest.ps1 -AllowedPath a,b,c` vs. `pwsh -Command "&argtest.ps1 -AllowedPath @('a','b','c')"` | n/a | `-File` form: `COUNT=1, ELEM=[a,b,c]` (glued into one string). `-Command`/array form: `COUNT=3, ELEM=[a] [b] [c]`. **Independently confirms the coordinator's DISC-002/RISK-007 claim exactly** — the `-File` invocation the plan documents everywhere silently discards the argument |
| Re-run `check-owned-paths.ps1 -Id FND-001` with the correct array form, present-day tree | 1 | `FAIL ... UNOWNED server/tests/vitest.globalSetup.mjs, UNOWNED vitest.config.js` — see Findings for why this is not an FND-001 regression |

## Failure-Path Review

- [x] malformed input — n/a, no runtime code path introduced
- [x] unavailable dependency/connector — n/a
- [x] timeout/interruption — n/a to this package; RISK-001 (cold-start timeout) is a pre-existing, separately tracked issue, not something FND-005 touches or masks. Confirmed: both of my `test:server` runs here had no timeout failures, consistent with a warm environment
- [x] duplicate/concurrent request — n/a
- [x] rollback/fallback — read `server/tests/vitest.globalSetup.mjs` end to end. The safety branch (lines 31-41) is the one thing worth independently judging, since the coordinator asked for it directly:
  **Judgment: the trade is correct as made.** If `paths.config.json` already exists, `setup()` returns immediately without writing or touching anything, and logs which branch it took. The alternative — overwriting a developer's real override — risks silently redirecting (or worse, corrupting) a live data root mid-test-run, which is a strictly worse failure mode than "the repo occasionally regrows `data/db.json` with an empty default schema." The condition is observable (the console line), the risk is disclosed and scored (RISK-008, medium, accepted) rather than hidden, and the teardown correctly tracks `weWroteTheConfig` so it never deletes a config it didn't create. One nuance worth recording for the coordinator, not a defect: if the pre-existing `paths.config.json` happens to point at a *real* production data root, `npm run test:server` would then read/write live `db.json` under test — that risk already exists independent of FND-005 (it's how `getDataPaths()`/`init.js` always resolved paths) and is not something a test-harness change can fully close; RISK-008's framing captures this correctly.
- [x] secret redaction — `server/tests/vitest.globalSetup.mjs` and `vitest.config.js` write only temp directory paths (`os.tmpdir()`-based) to `paths.config.json`; no credentials, tokens, or database content pass through either file. Confirmed by reading both files fully.

## Findings

Ordered by severity.

1. **[INFORMATIONAL] Running `check-owned-paths.ps1 -Id FND-001` today (correct array form) reports UNOWNED for FND-005's two new files — this is not an FND-001 defect, it's a consequence of FND-005 having been implemented directly in the coordinator's shared tree rather than an isolated worktree.**
   The plan requires "Concurrent implementation agents must use separate worktrees under `D:\Projects\ZCP-Modernized-worktrees\<WP-ID>`" once worktrees are unblocked (they were, by checkpoint `e966fe9`). FND-005 instead appears to have been done in-place in the coordinator's tree. This isn't wrong for a small, sequential, coordinator-owned package (FND-001 explicitly runs in the coordinator worktree too, and DISC-001's fix is arguably coordinator-adjacent infrastructure), but it does mean any *other* package's owned-path check run against this tree right now will see FND-005's files as stray, and vice versa once FND-005 is checked while later packages exist. Worth a brief note in `WORK_PACKAGES.md`/`STATUS.md` about why FND-005 didn't get its own worktree, if it's meant to set precedent — otherwise no action needed once FND-005 is committed/checkpointed.

2. **[CONFIRMED — carried over from DISC-002/RISK-007, already correctly filed by the coordinator] The owned-path guard silently ignores its `-AllowedPath` argument under the plan's documented invocation form.**
   I reproduced this myself, independently, before reading the coordinator's account: `pwsh -File script.ps1 -AllowedPath a,b,c` binds a single glued string (`elements=1`, `["a,b,c"]`) to a `[string[]]` parameter, because argument tokens passed to `-File` are not re-parsed by PowerShell's own comma-array-literal grammar. The corrected `-Command "& '...' -AllowedPath @('a','b','c')"` form binds correctly (`elements=3`). This is already filed as RISK-007 (critical, open) and DISC-002 in `DECISIONS.md`/`RISK_REGISTER.md`, and I have nothing to add to the coordinator's root-cause — my repro matches exactly. I flag it here only because Job 1 explicitly asked me to confirm or refute it: **I confirm it. The coordinator's analysis is correct.**

No other findings. The rollback instructions in `ROLLBACK.md` are correct and were not exercised (exercising them would delete the evidence under review, same reasoning as FND-001's).

## Spot re-check, 2026-09-03 (kevin, floor-wide FND-* reconciliation sweep)

Re-read the two load-bearing files directly against current `origin/main` (`761f41bc`, ~300 commits
and two point releases past this verdict's own date): `vitest.config.js` and
`server/tests/vitest.globalSetup.mjs` are both still present, unchanged in the mechanism this
verdict describes. Did not re-run the full repeatability proof (duplicating this file's own
already-thorough re-execution would add nothing) — code presence of the exact two files this
verdict's reasoning depends on is the evidence bar used consistently across this reconciliation
pass. **Verdict below still holds.**

## Verdict

PASS

Reason: The package's stated contract — stop `npm run test:server` from writing `data/db.json`/`data/backups/`/`logs/` into the repository, without changing test discovery or leaking into the client build — is met and independently reproduced. The repeatability proof is the load-bearing claim and I ran it myself: two consecutive `npm run test:server` runs, both exactly 535/535 across 51 files (matching the FND-001 baseline count exactly, so discovery was not silently narrowed), both leaving `data/db.json`, `data/backups/`, and `paths.config.json` absent afterward, followed immediately by `bootstrap-plan.ps1` returning `PASS runtime-db-absent` — the exact sequence that threw exit 1 before this fix. Client suite unaffected (90/90), lint clean, and the conditional-isolation safety branch (RISK-008) is a sound, disclosed trade rather than an oversight. The one new critical issue surfaced during scope-checking (DISC-002/RISK-007) is not a defect in FND-005 itself; it is a pre-existing tooling gap the coordinator already found, disclosed, and correctly did not try to quietly work around, and I independently confirm the coordinator's analysis of it is accurate.
