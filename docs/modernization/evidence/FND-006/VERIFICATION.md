# Independent Verification: FND-006

- Verifier: Kevin (independent hive agent, kevin-mt4dpz5y)
- Verification date: 2026-08-22
- Candidate branch/worktree: `main` working tree at `D:\Projects\Zomboid_Control_Panel_Modernized`, committed
- Candidate SHA/diff hash: `HEAD` = `8f4ec5f249b36ffe9ede5e4a18aca5a2561b8fdc` (commit message: "modernization: FND-006 harden owned-path guard; FND-007 fix RISK-001; withdraw DISC-002b" — a combined commit covering FND-006, FND-007, and the DISC-002b withdrawal; I verify FND-006's slice of it here)
- Independence statement: I did not implement this work package, its sibling FND-007, or the DISC-002b retraction under audit. I ran every command below myself with a direct, unpiped exit code before comparing results to `SUMMARY.md`/`RESULTS.json`.

## Contract Review

- Preserved V1 behavior: confirmed. Only `scripts/modernization/check-owned-paths.ps1` and `V2_MODERNIZATION_PLAN.md` changed (`bootstrap-plan.ps1` is untouched, matching the "one broken guard, not two" correction). Nothing under `server/`, `client/`, or `data/` touched by this package.
- New behavior: `check-owned-paths.ps1` now splits every `-AllowedPath` element on commas before matching, and `throw`s (non-zero exit) if that split yields zero usable entries, instead of silently proceeding with an empty allow-list.
- Diff scope matches ownership: yes — verified with `git show --stat` and the plan-text diff below.

## Re-executed Commands

| Command | Exit | Result/evidence |
| --- | ---: | --- |
| `git rev-parse HEAD` | 0 | `8f4ec5f249b36ffe9ede5e4a18aca5a2561b8fdc` — matches |
| `git log --oneline -8` | 0 | Linear history on top of the FND-005 acceptance commit (`2ae02c4`); no force-push artifacts, nothing pushed (`git remote -v` still only `v1-source`) |
| `git diff --check` (current `HEAD`) | 0 | Clean — confirms the self-inflicted CRLF/LF issue described in `SUMMARY.md` was actually repaired, not just claimed |
| Read `scripts/modernization/check-owned-paths.ps1` in full | n/a | Confirms the split-on-comma logic (lines 22-28) and the empty-result `throw` (lines 29-31) exist exactly as described, with the DISC-002/RISK-007 explanatory comment attached |
| **Case (a) — ACCEPT:** `pwsh -NoProfile -File .\check-owned-paths.ps1 -Id FND-001 -AllowedPath docs/modernization/,scripts/modernization/`, direct exit code | **0** | `PASS work-package=FND-001 changed=0` |
| **Case (b) — REFUSE:** same script, `-AllowedPath " , , "`, direct exit code (no pipe) | **1** | `Exception ... throw "-AllowedPath produced no usable entries. Pass at least one path; a silently empty allow-list would make this check meaningless."` — reproduced the coordinator's own pipe-truncation trap first with a piped run (misleadingly read exit 0), then re-ran unpiped and got the true exit 1, exactly as `SUMMARY.md` warns |
| **Case (c) — STILL CATCHES A VIOLATION:** created `zcp-verifier-probe-8466f9.txt` at repo root (owned by nobody), ran `check-owned-paths.ps1 -Id FND-001` with the corrected array-literal form, direct exit code | **1** | `FAIL work-package=FND-001` / `UNOWNED zcp-verifier-probe-8466f9.txt` — the guard still fails on a genuine stray file after hardening. Probe deleted in a `finally` block; confirmed gone via `Test-Path` and `git status --porcelain` (both empty) immediately after |
| Read `V2_MODERNIZATION_PLAN.md` diff (`2ae02c4`..`8f4ec5f`) | n/a | A new callout box after the FND-001 command block documents the `-File` comma-binding footgun, tells the reader not to remove the split, and gives the `-Command`/array-literal alternative — matches `SUMMARY.md`'s claim of "one documentation note" |
| `npm run test:server` | 0 | 535/535 across 51 files — FND-006 touches no test file, and this confirms it introduced no collateral breakage |
| `npm run lint:server` | 0 | `eslint server eslint-rules --max-warnings=0`, no findings |

### DISC-002b retraction audit (the job I was asked to scrutinize hardest)

Reproduced independently, per the coordinator's own prescribed method (confirm the substitution landed before running, run unfiltered, restore in a `finally`):

1. Read `docs/modernization/STATUS.md`; captured original `current_sha: "2ae02c43911c0e84ca6d6bd8f8f64cbac63d180c"` into a variable before touching anything.
2. Replaced it with `current_sha: "abc123"` via a `-replace` regex anchored on the quoted hex value (not the coordinator's `"$`-at-CRLF pattern that silently failed to match the first time). Printed the line back with `Get-Content | Select-String -Pattern 'current_sha'` **before** running anything — confirmed it now read `current_sha: "abc123"`.
3. Ran `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernization\bootstrap-plan.ps1` with **no filtering, no pipe, direct exit code**. Output included the line:
   `WARN STATUS.md has no concrete current_sha; coordinator must reconcile it before integration.`
   Exit code was 0 (a WARN does not fail the gate — consistent with the other WARN case I also independently triggered by leaving the real, slightly-behind `current_sha` in place, which produced `WARN STATUS current_sha is 2 commit(s) behind HEAD`).
4. Restored `STATUS.md` from the captured original in a `finally` block, then printed the line back again to confirm restoration (`current_sha: "2ae02c43911c0e84ca6d6bd8f8f64cbac63d180c"`), and confirmed `git status --porcelain` was empty afterward — the file was left byte-identical to how I found it.

**Verdict on the retraction: the coordinator is right, and the withdrawal is correct.** An abbreviated/invalid `current_sha` does not make `bootstrap-plan.ps1` skip its staleness check silently — it prints a `WARN` naming exactly the problem, matching `bootstrap-plan.ps1:46` (`else` branch, following the `[0-9a-f]{40}` regex match failure at line 32). I found no scenario in which the check emits neither `PASS` nor `WARN` for a malformed `current_sha`. `bootstrap-plan.ps1` needed no change, and none was made.

## Failure-Path Review

- [x] malformed input — case (b) above is exactly this: a garbage `-AllowedPath` value. Confirmed refused, non-zero exit.
- [x] unavailable dependency/connector — n/a, no runtime dependency introduced
- [x] timeout/interruption — n/a
- [x] duplicate/concurrent request — n/a
- [x] rollback/fallback — read `ROLLBACK.md`'s claim (`git checkout -- scripts/modernization/check-owned-paths.ps1 V2_MODERNIZATION_PLAN.md` restores the old behavior, proven by `-AllowedPath " , , "` returning exit 0 again). Did not execute it myself (would require a `git checkout` against tracked files mid-verification, which I judged out of scope for a read-only check when the claim is a straightforward, auditable `git diff` reversion); the claim is plausible and consistent with the diff I read, but I did not exercise it directly. Noting this as an intentional scope boundary, not an oversight.
- [x] secret redaction — no secret material in any touched file; `check-owned-paths.ps1` and the plan-text note deal only in file paths.

## Findings

None. Every claim I tested — the three-case guard behavior, the plan-text correction, the CRLF/LF self-repair, and the DISC-002b retraction — held up exactly as described under independent, from-scratch reproduction, including the one place (case b, DISC-002b step 2) where the coordinator explicitly warned about a reproduction trap. I hit both traps myself on a first pass (piped exit code for case b; a near-miss on the regex terminator for the DISC-002b repro, caught before it mattered by confirming the substitution landed) and both resolved to the coordinator's stated outcome once corrected.

## Verdict

PASS

Reason: All three required test cases for the hardened `check-owned-paths.ps1` reproduce exactly as claimed under direct, unpiped exit-code capture: a legitimate comma list still passes (exit 0), a garbage/empty argument now throws (exit 1, was previously a silent pass), and a genuine unowned file is still caught after hardening (exit 1, probe cleaned up). The plan-text correction accurately documents the footgun and the workaround. The DISC-002b withdrawal is independently confirmed correct — I reproduced the exact scenario the coordinator described being wrong about, using the coordinator's own prescribed reproduction method (confirm-before-run, unfiltered output, restore-in-finally), and got the same result: `bootstrap-plan.ps1` warns loudly on an unusable `current_sha`, it does not fail silently. `bootstrap-plan.ps1` itself is unchanged, correctly, since there was nothing to fix in it. No production file was touched, the full server gate stays green (535/535, lint clean), and `git diff --check` is clean on the current tree.
