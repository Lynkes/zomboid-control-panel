# Independent Verification: FND-007

- Verifier: Kevin (independent hive agent, kevin-mt4dpz5y)
- Verification date: 2026-08-22
- Candidate branch/worktree: `main` working tree at `D:\Projects\Zomboid_Control_Panel_Modernized`, committed
- Candidate SHA/diff hash: `HEAD` = `8f4ec5f249b36ffe9ede5e4a18aca5a2561b8fdc` (combined commit with FND-006 and the DISC-002b withdrawal; I verify FND-007's slice — the `server/tests/bugfixes.test.js` change — here)
- Independence statement: I did not implement this work package. I read the RISK-001 diagnosis (dynamic `import()` memoization, first caller absorbs cold cost inside its own `testTimeout`) as background from earlier in this program before this fix existed, but I re-derived every number and claim below from the repository and re-run commands, not from `SUMMARY.md`.

## Contract Review

- Preserved V1 behavior: confirmed. The only file changed is `server/tests/bugfixes.test.js` — test infrastructure, not production code. Verified via `git show --stat HEAD` (single file) and the full diff.
- New behavior: `DiscordBot` is imported once, statically, at module load time instead of being re-imported dynamically inside 11 separate test-body closures.
- Diff scope matches ownership: yes — one test file, matching FND-007's declared scope.

## Re-executed Commands

| Command | Exit | Result/evidence |
| --- | ---: | --- |
| `git diff 2ae02c4 8f4ec5f -- server/tests/bugfixes.test.js` (full diff read) | n/a | Exactly 11 occurrences of `const { DiscordBot } = await import("../services/discordBot.js");` removed from 11 different `describe` blocks' helper functions, and one `import { DiscordBot } from "../services/discordBot.js";` added at the top of the file with an explanatory comment ("Do not move this back inline") |
| `grep -c "await import(" server/tests/bugfixes.test.js` filtered to `discordBot` | 0 matches via that filter, but direct read found 1 | **One dynamic `await import("../services/discordBot.js")` remains**, at line 740, inside "falls back to the full public scope for an unknown stored value" — but it destructures `normalizeChatRelayScope`, a *different* named export than `DiscordBot`. This is not one of the "11 identical" lines `SUMMARY.md` describes (it never claims all dynamic imports of the module were removed, only the 11 identical `DiscordBot` ones), and it poses no residual risk: the static import at line 10 already fully resolves and caches the module before any test runs, so this remaining dynamic import is a same-specifier cache hit, not a cold import. Confirmed by its own measured duration below (0ms). See Findings. |
| `grep -c "vi\.mock(\|vi\.doMock(\|vi\.resetModules(\|vi\.unmock("` individually across `server/tests/bugfixes.test.js` | 0 for all four | **Confirmed: zero module-mocking calls of any kind in this file.** The static-import justification ("nothing depends on lazy loading") holds. |
| Read lines 1-25 of the file | n/a | Confirms the file already statically imports `../routes/auth.js` and `../routes/mods.js` before this change, supporting the "this pattern already exists in this file" claim |
| `npx vitest run server/tests/bugfixes.test.js --reporter=verbose`, read the duration of "forwards ordinary Say chat, which B42 uses for normal talking" | 0 | **1ms.** Matches the coordinator's claim of "~1ms, down from 1488ms" exactly. Test Files 1 passed (1), Tests 93 passed (93) |
| Same verbose run, durations of its immediate neighbors in the "Discord chat relay scope" `describe` block | 0 | 0ms, 0ms, 0ms, 0ms, 0ms, 0ms (the remaining dynamic-import test) — the target test sits inside the 0-5ms band of its peers, not as an outlier. Confirms the fix closed the *cause* (cold transform cost), not merely the symptom |
| `npm run test:server` (full suite) | 0 | **Test Files 51 passed (51). Tests 535 passed (535).** Exact same count as the FND-001 baseline and the FND-005 re-verification — confirms removing 11 lines did not silently drop or skip any test |
| `npm run lint:server` | 0 | `eslint server eslint-rules --max-warnings=0`, no findings |

## Failure-Path Review

- [x] malformed input — n/a, no runtime input path changed
- [x] unavailable dependency/connector — n/a
- [x] timeout/interruption — this **is** the failure path the package fixes. Directly measured: the previously-timing-out test now runs in 1ms, comfortably inside the 5000ms `testTimeout` with roughly three orders of magnitude of margin, not a marginal improvement that could regress again on a slower machine
- [x] duplicate/concurrent request — n/a
- [x] rollback/fallback — `SUMMARY.md`'s rollback (`git checkout -- server/tests/bugfixes.test.js`) is a trivial, verifiable single-file revert; read but not executed (would require mutating a tracked file mid-verification for a claim that's self-evidently correct from the diff — judged out of scope, consistent with my approach on FND-006's rollback claim)
- [x] secret redaction — no secret material touched; the change is import restructuring only

## Findings

1. **[INFORMATIONAL, not a defect] One dynamic `await import("../services/discordBot.js")` remains in the file (line 740), for a different named export (`normalizeChatRelayScope`) than the one that was hoisted (`DiscordBot`).** This does not reintroduce RISK-001: the static top-level import at line 10 guarantees the module is fully resolved and cached before any test in the file runs, so this remaining dynamic import is a same-specifier cache hit rather than a fresh cold transform. Directly confirmed by measurement — the test containing this dynamic import ("falls back to the full public scope for an unknown stored value") itself runs in 0ms. `SUMMARY.md`'s claim ("removed 11 identical ... lines") is technically precise as stated and does not claim exhaustive removal of every dynamic import in the file, so this is not a misstatement — I record it only because Job 2 asked me to verify the mock-safety claim thoroughly, and this is the kind of leftover that class of check is meant to catch. No action needed.

## Spot re-check, 2026-09-03 (kevin, floor-wide FND-* reconciliation sweep)

Re-read `server/tests/bugfixes.test.js` directly against current `origin/main` (`761f41bc`): the
static top-level import (`import { DiscordBot } from "../services/discordBot.js"`) is at line 10,
and a fresh `grep -c 'await import("../services/discordBot'` returns 0 — the fix is fully intact,
not partially reverted. The one leftover dynamic import this file's own Findings section noted
(a different export, `normalizeChatRelayScope`) is still present too, now around line 925 (shifted
from the "line 740" this document originally cited — expected, ~300 commits have landed in this
file's neighborhood since) — same harmless shape as originally found, confirmed by re-reading the
surrounding test rather than trusting the old line number. **Verdict below still holds.**

## Verdict

PASS

Reason: The load-bearing number is independently reproduced exactly — "forwards ordinary Say chat" now runs in 1ms (was 1488ms), sitting inside its neighbors' 0-5ms band rather than as an outlier, confirming the fix addressed the diagnosed cause (cold `import()` transform cost absorbed inside a single test's `testTimeout`) rather than merely suppressing the symptom. The full server suite is unchanged at exactly 535/535 across 51 files, so removing 11 lines dropped no coverage. The static-import safety justification is independently verified: zero `vi.mock`/`vi.doMock`/`vi.resetModules`/`vi.unmock` calls exist anywhere in the file, so nothing in this test file depends on lazy module loading, and the file already established the same static-import pattern for two other route modules before this change. One harmless leftover dynamic import (a different export, already-warm module) is noted for completeness but does not affect the verdict. Lint clean, single-file diff scope, no production code touched.
