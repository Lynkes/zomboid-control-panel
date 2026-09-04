# Diff Scope: FND-007

> **Filled in 2026-09-03 (kevin) — this file was an unfilled template.** Content transcribed from
> `SUMMARY.md`, `WORK_PACKAGE.md`, `RESULTS.json`, and `git show --stat 8f4ec5f2` (the real commit
> this package's change landed in, alongside FND-006).

- Base SHA: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`, per `RESULTS.json.baseline_sha`)
- Candidate SHA/diff hash: `8f4ec5f249b36ffe9ede5e4a18aca5a2561b8fdc`

## Declared Ownership

- `server/tests/bugfixes.test.js`
- `docs/modernization/evidence/FND-007/**`

## Actual Changed Paths

Per `git show --stat 8f4ec5f2` (shared commit with FND-006 — table lists only this package's own
file; FND-006's are in its own `DIFF_SCOPE.md`):

| Path | Change type | Why required | Owner-approved |
| --- | --- | --- | --- |
| `server/tests/bugfixes.test.js` | modified | removed 11 identical dynamic `import("../services/discordBot.js")` calls from inside test bodies, added one static top-level import | Yes |
| `docs/modernization/evidence/FND-007/**` | added | package evidence | Yes |

**No production file touched** — the only change is to a test file (`SUMMARY.md`'s own contract
statement).

## Coordinator-Owned Hunks

| File | Symbol/section | Patch purpose | Integration order |
| --- | --- | --- | --- |
| `server/tests/bugfixes.test.js` | top-level imports + 11 call sites | hoist `discordBot.js` import out of the per-test 5000 ms timeout (RISK-001) | n/a — single-commit package |

## Generated / Runtime Files

None.

## Scope Verdict

**PASS**

Test-file-only change, confirmed by `git show --stat 8f4ec5f2` showing exactly one file touched by
this package (`server/tests/bugfixes.test.js`) plus its own evidence directory. `RESULTS.json`
confirms the server suite count held at 535/535 across 51 files, so removing 11 imports and adding
1 dropped or skipped nothing.
