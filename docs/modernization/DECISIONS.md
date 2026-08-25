# Modernization Decisions

ADR IDs are `ADR-<WP-ID>-<NN>`. This file reserves and indexes them; full records live at the
listed path.

| ID | Title | Status | Work package | Date | Path |
| --- | --- | --- | --- | --- | --- |
| _none_ | — | — | — | — | — |

FND-001 produced **no ADR**. It recorded state rather than deciding architecture. The first
decision records belong to `DB-001` (`ADR-DB-001`, data model) and `AUT-001` (`ADR-AUTH-001`,
identity).

---

## Plan Discrepancies

The plan states: *"If an agent discovers that the plan is wrong, it must record the discrepancy in
a decision record and stop at the current work-package boundary. It must not silently reinterpret
the architecture."* This section is that record. These are **not** ADRs — they are defects found
in the program's own tooling, raised for the user's decision.

### DISC-001 — the mandatory baseline gate violates the mandatory preflight

**Severity: high. Blocks nobody today; will confuse everybody tomorrow.**

`scripts/modernization/bootstrap-plan.ps1` asserts `runtime-db-absent` and throws
`data/db.json must not exist in the modernization fork baseline.` (line 72) when the file is
present. The plan reinforces this as a product invariant: *"Never copy, overwrite, delete, or
deploy a runtime `data/db.json`."*

**But the plan's own required baseline gate creates that file.**

**Root cause, located by the independent verifier and confirmed by the coordinator:**
`server/database/init.js` resolves `getDataPaths()` at line 37 and then, at **lines 43-50, runs a
bare top-level `for` loop calling `fs.mkdirSync`** for `dataDir` and `backupDir`. This is a
**module-load-time side effect**: merely *importing* the module creates `data/` and
`data/backups/`, before any function is called, whenever no `paths.config.json` override is
present. The FND-001 clean-room sequence wraps only the perf-measurement server start in that
override — it does not wrap `npm run test:server`.

The coordinator's initial reading ("the test suite boots the database") named the *trigger*; the
verifier's names the *cause*, and the difference matters, because any future command that imports
this module inherits the behavior — not only the test suite.

**This raises the stakes rather than lowering them.** The comment at `init.js:42` states these
directories hold `db.json` containing an *RCON password and JWT secret*. The guard is protecting a
genuinely sensitive file, which is why it must not be weakened.

Observed during FND-001:

| Artifact | Created |
| --- | --- |
| `data/db.json` | 2026-08-22T13:00:08Z |
| `data/backups/db-2026-08-22T12-59-20-264Z-startup.json` | during cold `test:server` |
| `data/backups/db-2026-08-22T12-59-22-508Z-startup.json` | during cold `test:server` |
| `data/backups/db-2026-08-22T12-59-51-830Z-startup.json` | during isolated `bugfixes.test.js` |
| `data/backups/db-2026-08-22T13-00-07-193Z-startup.json` | during warm `test:server` |
| `data/backups/db-2026-08-22T13-00-08-563Z-startup.json` | during warm `test:server` |
| `logs/combined.log`, `logs/error.log` | during `test:server` |

Five startup backups for five server boots across three test invocations. All six JSON files share
SHA-256 prefix `8532BB2E3FFA75E8` — every one is the identical empty default database, so no data
accumulated and nothing of value was at risk.

**Consequence: the documented FND-001 clean-room sequence cannot be run twice.** Its final step
re-runs `bootstrap-plan.ps1`, which now throws on an artifact the sequence itself produced. This
was hit for real during FND-001 and is reproducible.

**Ruled out as the cause:** the performance procedure. Its temporary `paths.config.json` correctly
redirected data and log roots to `%TEMP%`, and no artifact carries a 13:02 timestamp. The perf step
is clean; the test gate is not.

**Not a secret-exposure finding.** `data/db.json` contained only empty collections and
`_schemaVersion: 1`. A scan of `logs/combined.log` for `password|token|secret|cookie|authorization|bearer`
returned 12 hits, **all of them the word alone in event notices** ("Password reset for user: admin",
"cannot complete an interactive password prompt") with no values. V1's logging redacts correctly —
a positive result worth recording, since it is a precondition the later auth packages depend on.

**Handling in FND-001:** the generated files were removed and `bootstrap-plan.ps1` returned to
`RESULT=PASS` / `runtime-db-absent`. Removal was safe and is not a data-loss event: the files were
untracked, gitignored (`.gitignore:9` and `:29`), machine-generated minutes earlier, byte-identical
empty seeds, and this fork has never held a real database.

**Options for the user — this is a decision, not a cleanup:**

1. ~~**Teach the preflight the difference**~~ between a *runtime* `data/db.json` and a
   *test-generated* empty one. **Withdrawn.** `init.js:42` records that this file holds an RCON
   password and JWT secret, so the guard protects real secret material. Making it lenient weakens
   the one check standing between a test run and a user's live database, in exchange for saving two
   lines of cleanup.
2. **Isolate the test suite's data root** so it never writes into the repository, mirroring what the
   perf step already does correctly with `paths.config.json`. Cleanest, but edits test
   infrastructure, which FND-001's contract forbids and which therefore needs its own package.
3. **Document a mandatory cleanup step** after the gate. Zero code change, but relies on every
   future agent remembering — and the failure mode is a confusing throw, not a silent one.
4. **Accept and leave as-is**, with the behavior recorded here so nobody loses time to it.

**Recommendation: option 2, as a small package before FND-002.** The perf step already proves the
override mechanism works, so the pattern is established rather than invented. Because the cause is
a module-load-time side effect, the isolation must wrap *any* command that imports
`server/database/init.js`, not the test script alone.

**Status: DECIDED by the user on 2026-08-22 (option 2, isolate the data root) and RESOLVED by
work package FND-005 the same day.** Cross-referenced as RISK-006, now resolved.

**Proof the defect is actually closed**, rather than merely worked around: a second consecutive
`npm run test:server` followed immediately by `bootstrap-plan.ps1` now returns
`PASS runtime-db-absent`, exit 0. Before FND-005 that exact sequence threw. The suite still reports
**535 tests across 51 files** — unchanged — so the newly introduced root `vitest.config.js` did not
alter test discovery, which was the main risk of the fix.

### Implementation as built (FND-005)

Two facts found while scoping the fix, both of which constrain it:

1. **There is no environment-variable override.** `server/utils/paths.js:30` `getDataPaths()`
   resolves only from a `paths.config.json` file at the project root, and **memoizes the result in
   a module-level `currentPaths`**. The override must therefore exist on disk *before* the first
   import, not be set at runtime. This is why the plan's perf step writes a temp file rather than
   exporting a variable.
2. **There is no server-side vitest config.** `npm run test:server` is bare
   `vitest run server/tests` on vitest defaults; the only config in the repo is
   `client/vite.config.ts`. So the fix must *create* a root `vitest.config.js`.

Shape as built — test infrastructure only, **no production file touched**:

- a root `vitest.config.js` setting `test.globalSetup` and nothing else, so existing default
  behavior is preserved;
- a global setup that **refuses to run if `paths.config.json` already exists** (never clobber a
  real user override), writes one pointing at a temporary root, and removes it in teardown.

`globalSetup` runs in the main process before workers spawn, which satisfies the
memoization constraint in fact 1.

**Risk to watch, and the reason this needs its own gates:** introducing a root `vitest.config.js`
where none existed can change how the existing 535 tests are discovered or run. The acceptance
check is therefore not merely "the artifacts stop appearing" but "the suite still reports 535
tests" — a changed test count would mean the config altered discovery, which would be a worse
regression than the defect being fixed.

**Sequencing note (historical):** the fix was deliberately held until the concurrent RISK-001 investigation finished, because changing the test harness underneath an agent running that exact suite would have invalidated the investigation. It was implemented immediately after that report landed.
exact suite; changing the harness underneath that investigation would invalidate it. The fix waits
for that report.

**Discovery record.** Found independently twice: by the coordinator when a post-ledger re-run of
`bootstrap-plan.ps1` threw, and by the independent verifier before reading the coordinator's
evidence. The verifier's `VERIFICATION.md` returned **FAIL** on this finding, which is the correct
verdict — FND-001 cannot be accepted while its own precondition fails. The verifier also traced
the cause to the exact lines. Two independent discoveries of the same defect, from different
starting points, is the reason this is recorded as a plan defect rather than a local mishap.

### DISC-002 — the owned-path guard reports PASS without reading its argument

**Severity: high. A check that cannot fail is worse than no check, because it is trusted.**

The plan documents this invocation (`V2_MODERNIZATION_PLAN.md`, FND-001 section):

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass `
        -File .\scripts\modernization\check-owned-paths.ps1 `
        -Id FND-001 `
        -AllowedPath docs/modernization/,scripts/modernization/
```

**`pwsh -File` binds a comma-separated value as ONE string, not an array.** Demonstrated directly:

```
pwsh -File ... -AllowedPath a,b,c   ->   elements=1   ["a,b,c"]
```

`check-owned-paths.ps1` then tests `$path.StartsWith("docs/modernization/,scripts/modernization/")`,
which matches nothing. **Every `-AllowedPath` passed this way is silently discarded.**

**Why nobody noticed.** The script carries a hardcoded `$initialHandoff` fallback allowing
`V2_MODERNIZATION_PLAN.md`, `AGENTS.md`, `docs/modernization/`, and `scripts/modernization/` for
*untracked* files. FND-001's paths are exactly those, so it returned `PASS work-package=FND-001
changed=55` **via the fallback, having never evaluated the argument at all.** The guard appeared to
work because the package under test happened to need nothing beyond the fallback.

**How it surfaced.** FND-005 owns `vitest.config.js` and `server/tests/vitest.globalSetup.mjs` —
paths outside the fallback. The check returned `FAIL ... UNOWNED vitest.config.js`, which is the
correct answer for the wrong reason: not because ownership was violated, but because the allowance
never parsed. Re-running with a genuine array returns `PASS work-package=FND-005 changed=12`.

**This is the dangerous shape:** the first package that actually depends on the argument is the
first package that gets a wrong answer, and by then the check has a track record of passing.

**Correct invocation** — pass a real array, which requires `-Command`, not `-File`:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -Command `
  "& '.\scripts\modernization\check-owned-paths.ps1' -Id FND-005 " +
  "-AllowedPath @('vitest.config.js','server/tests/vitest.globalSetup.mjs')"
```

**Options for the user:**

1. **Fix the documented command** in the plan to the `-Command` form above. Smallest change; the
   script itself is correct.
2. **Make the script defensive** — split any element containing a comma, so both invocation styles
   work. Slightly more code, but removes a foot-gun every future package would otherwise re-arm.
3. **Both.** Recommended: the script stops accepting a malformed argument silently, and the
   documented command stops producing one.

**Status: open, awaiting user decision. Not fixed.** FND-005's own scope was verified with the
correct invocation, so its result is sound; the plan's documented command remains wrong. Recorded
as RISK-007.

### DISC-002b — WITHDRAWN. I was wrong, and the guard is correct.

**RETRACTED 2026-08-22, same day it was filed. There is no defect here.**

I claimed that an abbreviated `current_sha` in `STATUS.md` made `bootstrap-plan.ps1` skip its
staleness check silently, emitting neither PASS nor WARN. **That is false.** Reproduced properly,
with the substitution confirmed before the run and the output left unfiltered, the script prints:

```
WARN STATUS.md has no concrete current_sha; coordinator must reconcile it before integration.
```

That is exactly the right behaviour: `bootstrap-plan.ps1:32` requires `[0-9a-f]{40}`, and the
`else` branch at line 46 reports the miss in plain language. The guard checked, failed to find a
usable value, and said so.

**How I got it wrong.** I ran the script through
`Select-String -Pattern "RESULT|status-current|runtime-db"`. That pattern does not contain `WARN`.
The warning was printed and my own filter removed it — then I reported the absence as a finding.

**Two compounding mistakes, both worth naming:**

1. **I treated filtered output as complete output.** The evidence for "the line was missing" was
   produced by a command that could not have shown that line.
2. **My first attempt to reproduce it silently did nothing.** The regex ended in `"$`, and the file
   has CRLF endings, so `$` never matched past the ``. The substitution failed, the run exercised
   the 40-char path, and it *appeared* to confirm the bug. I only caught it by printing the
   substituted line before running — which is the check I should have had from the start.

**The irony is the lesson.** DISC-002b was supposed to be a second example of "a check that reports
success without evaluating its input." It turned out to be *me* doing exactly that, twice: a grep
that could not observe what I claimed, and a mutation that never applied. **A verification that
cannot fail proves nothing, whoever runs it.**

**Consequences of the retraction:**

- `bootstrap-plan.ps1` needs **no change**. It is not part of FND-006.
- DISC-002 stands unaffected. It is real, reproduced twice by me and independently by the verifier
  with his own script before reading my writeup.
- The "two guards" framing in earlier commit messages and STATUS text was wrong. **There is one
  broken guard, not two.**

**Kept rather than deleted**, because a withdrawn finding that leaves no trace teaches nobody, and
the next reader deserves to know this claim was made and why it failed.
