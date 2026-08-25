---
plan_version: "2.0"
baseline_sha: "8642dc467938a47ca8aac76fc44fc1875446c88b"
current_sha: "2ae02c43911c0e84ca6d6bd8f8f64cbac63d180c"
active_work_package: "none - Foundation review gate"
state: "accepted"
owner: "coordinator"
updated_at: "2026-08-22T13:58:00.0000000Z"
---

# Modernization Status

## Checkpoint

- **Local-only checkpoint commit:** `e966fe94c7d6aca60986c7704a80e576bc1fa9f3` on `main`
- **Authorized by:** the user, explicitly, on 2026-08-22
- **Not pushed, not tagged, no remote created.** `git remote -v` shows only `v1-source` (the
  read-only V1 reference). There is no `origin`, so there is no default push target.
- **Contents:** 55 files, 4484 insertions — handoff, toolkit, 8 ledgers, FND-001 evidence.
  Verified to contain no `data/db.json`, no `data/backups/`, no `logs/`, no `node_modules`, and no
  `client/dist`.
- **No V1 source file is modified by this commit.**

Worktree creation is now unblocked (RISK-005 cleared): the handoff files are tracked, so
`create-worktree.ps1` will find them.

## Operator Grant (2026-08-22)

The user widened the working latitude inside this fork: **running the panel, running a PZ server,
and creating a real database in `D:\Projects\Zomboid_Control_Panel_Modernized` are all permitted.**

Unchanged and still binding: `D:\Zomboid_dev_panel\GitHub` and `D:\Projects\Zomboid_dev_panel V2`
are strictly read-only; no push, tag, publish, or remote; no deployment to the existing Tower V1
container (a *new* container is the eventual target, and only with explicit approval).

Note the interaction with DISC-001: the operator being content to have a database in this fork does
**not** dissolve the defect. `bootstrap-plan.ps1` still throws, so the sequence still cannot run
twice — and the operator separately chose the isolation remediation.

## Current Package

- **Contract:** FND-001 establishes program ledgers, baseline runtime facts, the API/DB inventory
  starting point, a performance baseline, and the evidence structure. It must not modify
  production behavior — and did not.
- **Dependencies:** none. FND-001 is the dependency-graph root.
- **Owned paths:** `docs/modernization/{README,STATUS,STATUS_ARCHIVE,WORK_PACKAGES,DECISIONS,RISK_REGISTER,BASELINE,ROLLBACK}.md`,
  `docs/modernization/evidence/FND-001/**`, `scripts/modernization/**`
- **Cheapest falsifier:** `npm ci` in both trees, then
  `git diff --exit-code -- package-lock.json client/package-lock.json`. Exit 0 — lockfiles
  byte-identical, so the baseline is reproducible. Hypothesis not disproven.
- **Rollback:** delete the 18 authored files (`evidence/FND-001/` plus the 8 ledgers). No git
  operation; nothing was staged or committed. Success signal: `bootstrap-plan.ps1` flips from
  `mode=resume` back to `mode=baseline`. See `evidence/FND-001/ROLLBACK.md`.

## Last Green Full Gate

- **Git SHA:** `e966fe94c7d6aca60986c7704a80e576bc1fa9f3` + uncommitted FND-005
- **Date:** 2026-08-22
- **Server tests:** 535 passed / 535 across 51 files, exit 0. Run twice consecutively post-FND-005,
  green both times, with `bootstrap-plan.ps1` passing after each — the repeatability that DISC-001
  used to prevent. (During FND-001, before the fix, a *cold* run was 534/535 exit 1; cause now
  diagnosed as RISK-001.)
- **Client tests:** 90 passed / 90 across 14 files, exit 0
- **Typecheck/build/lint/diff:** `tsc -b` exit 0 no diagnostics; `npm run build` exit 0;
  `lint:server --max-warnings=0` exit 0; `git diff --check` exit 0
- **Evidence link:** `evidence/FND-001/RESULTS.json`, `evidence/FND-001/PERF.json`

## Reserved Paths

| Work package | Owner | Paths | State |
| --- | --- | --- | --- |
| _none_ | — | All FND-001 and FND-005 reservations released on acceptance | — |

The verifier holds `VERIFICATION.md` exclusively. The coordinator implemented FND-001 and must not
author its sign-off.

## Blockers

~~**BLOCKER 1 — DISC-001 / RISK-006.**~~ **RESOLVED by FND-005.**

*What it was:* `server/database/init.js:43-50` is a bare top-level `for` loop of `fs.mkdirSync`, so
**importing** the module created `data/`, `data/backups/`, and a default `data/db.json`.
`bootstrap-plan.ps1` then threw, meaning the documented sequence could not be run twice. Found
independently twice (coordinator and verifier); independent verification returned **FAIL** on it,
correctly.

**Fixed and proven.** A second consecutive `npm run test:server` followed immediately by
`bootstrap-plan.ps1` now returns `PASS runtime-db-absent`, exit 0 — the exact sequence that threw
before. The suite still reports 535 tests across 51 files, so test discovery was not altered by the
new root `vitest.config.js`.

~~**BLOCKER 2 — RISK-005.**~~ **CLEARED** by checkpoint `e966fe9`. The handoff files are tracked,
so worktrees can now be created and FND-002 / FND-003 / DB-001 may run in parallel once FND-001 is
accepted.

**Both user decisions are in:**

1. **DISC-001 → isolate the data root.** **DONE** as work package FND-005 (in review).
2. **Checkpoint commit → authorized and created** as `e966fe9`, local only, not pushed.
3. **RISK-001 → investigate now.** **DONE.** Verdict (A), tight timeout, cause located. See below.

**The remaining open questions for the user are DISC-002 and the RISK-001 fix — both listed under
Next Exact Action.**


## New This Session

**FND-005 (review)** — the DISC-001 remediation. Two new test-infrastructure files; **no production
file touched**. Full gate green. Awaiting independent verification.

**RISK-001 — DIAGNOSED, fix not applied.** Verdict (A): a tight timeout, not a race.
`bugfixes.test.js:658` does `await import("../services/discordBot.js")` *inside the test body*.
`import()` memoises per specifier, so the **first** caller absorbs the whole cold transform cost of
discord.js (478 files / 4.2 MB) inside its own 5000 ms budget — and the first caller is exactly the
failing test at line 671. Confirmed on a warm box: that one test runs 1488 ms against 0-5 ms for
every neighbour, a 300-1000x outlier that is purely import-bound. (B) was ruled out **on code
grounds** — `handleGameChat` was read end to end: no timers, no retry, no circuit breaker, no
network. **Recommended fix, awaiting your decision:** hoist the import into a one-time `beforeAll`
for that describe block and its 10 sibling call sites. Explicitly *not* recommended: bumping this
one timeout (symptom) or raising the global default (would mask real slow-test regressions).

**DISC-002 / RISK-007 — critical, open.** `pwsh -File ... -AllowedPath a,b` binds the comma list as
a **single string**, so `check-owned-paths.ps1` silently discards every allowed path. Proven:
`elements=1`, `["a,b,c"]`. FND-001's earlier `PASS` came from the script's hardcoded
`$initialHandoff` fallback, not from the argument — **the guard reports PASS without reading its
input.** Independently reproduced by the verifier with his own script before reading my writeup.
Being fixed as FND-006 (user chose: harden the script *and* correct the plan text).

**DISC-002b — WITHDRAWN, my error.** I claimed a short `current_sha` made the staleness check
no-op silently. It does not: it prints `WARN STATUS.md has no concrete current_sha`. I had filtered
my own output with a pattern that omitted `WARN`, then reported the absence as a finding — and my
first reproduction attempt silently failed on CRLF, appearing to confirm it. `bootstrap-plan.ps1`
needs no change. **There is one broken guard, not two.** Full retraction in `DECISIONS.md`.

## Independent Verification

Both packages verified by a different agent, read-only, owning only the two `VERIFICATION.md` files.

**FND-005: PASS.** The verifier independently reproduced the repeatability proof — two consecutive
`test:server` runs, both **exactly 535/535 across 51 files** (matching the FND-001 baseline, so the
new root config did not narrow discovery), both leaving `data/db.json`, `data/backups/`, and
`paths.config.json` absent, with `bootstrap-plan.ps1` passing immediately after the second. Client
suite unaffected at 90/90. Judged the RISK-008 safety branch the correct trade.

**FND-001: FAIL → PASS.** The verifier kept the round-1 FAIL text intact and *appended* a round-2
section rather than erasing history — the right call. Confirmed HEAD is `e966fe9`, RISK-005 now
appears in `RESULTS.json`, and `SUMMARY.md` carries the full disclosure. He also noted that
SUMMARY.md's interim **BLOCK** recommendation was correct ordering rather than staleness, since
FND-005 was still unverified when it was written.

**DISC-002 independently confirmed.** He reproduced the argument-binding defect with **his own
throwaway script before reading my writeup** — `-File` binds `count=1`, `-Command` with a real array
binds `count=3` — and confirmed the implication against himself: his own round-1 `PASS` for
FND-001 was accidentally correct via the hardcoded fallback, never via his argument.

## Next Exact Action

**Stop. Two open questions for the user; nothing else proceeds.**

1. **DISC-002 / RISK-007 (critical).** `check-owned-paths.ps1` as the plan documents it discards its
   `-AllowedPath` argument silently. Fix the plan text, harden the script, or both? Recommended:
   both — so the script stops accepting a malformed argument *and* the documented command stops
   producing one.
2. **RISK-001 fix.** Apply the recommended hoist of the `discordBot.js` import into `beforeAll`?
   Test-only, low risk, would make the suite deterministic on a cold run.

Also awaiting: acceptance of FND-001 and FND-005, both pending independent verification (dispatched).

Once those land, the Foundation review gate applies before FND-002 / FND-003 / DB-001 begin — the
plan requires a coordinator review at that boundary, and agents must not assume approval from
silence.

```powershell
# Verify current state at any time. Safe to re-run; FND-005 made this repeatable.
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernizationootstrap-plan.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernizationalidate-handoff.ps1
```

## Recent Accepted Packages

Keep only the latest three here. Move older entries to `STATUS_ARCHIVE.md`.

| Package | SHA | Accepted at | Evidence |
| --- | --- | --- | --- |
| FND-001 | `e966fe9` (+ evidence uncommitted at accept time) | 2026-08-22 | `evidence/FND-001/` |
| FND-005 | `2ae02c4` | 2026-08-22 | `evidence/FND-005/` |

Both accepted by the coordinator **after** independent verification returned PASS, which is the
only order the plan permits. FND-001's first verification returned FAIL; it was fixed, re-verified,
and only then accepted.

## Accepted Decisions

None. FND-001 recorded state rather than deciding architecture; it produced no ADR. The first
decision records belong to `DB-001` (`ADR-DB-001`, data model) and `AUT-001` (`ADR-AUTH-001`,
identity).

## Open Risks

RISK-001 high (cold-run test failure — baseline green but not deterministic), RISK-002 high
(`db.example.json` stale against `defaultData`), RISK-003 high (perf baseline covers one route),
RISK-004 medium (bundle size unmeasured), RISK-005 medium (worktrees blocked pending checkpoint).
See `RISK_REGISTER.md`.
