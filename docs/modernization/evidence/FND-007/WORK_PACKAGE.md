# FND-007: Hoist the discordBot import out of the per-test timeout (RISK-001)

- State: review
- Owner: coordinator
- Worktree: coordinator worktree (no branch)
- Branch: none
- Dependencies: none
- Reviewer: independent verifier

## Contract Preserved

All V1 behavior. No production file is touched. The only change is
`server/tests/bugfixes.test.js`.

## New Capability

The server suite is deterministic on a cold run instead of green-by-luck.

## Owned Paths

- `server/tests/bugfixes.test.js`
- `docs/modernization/evidence/FND-007/**`

## Explicit Non-Goals

- Not raising the failing test's timeout. That treats the symptom and leaves a 4.2 MB import inside
  a per-test budget, so the next slow machine simply moves the failure to whichever test lands first.
- Not raising the global `testTimeout`, which would mask genuine slow-test regressions suite-wide.
- Not touching `server/services/discordBot.js`. The production code is not at fault.

## Hypothesis and Cheapest Falsifier

- Hypothesis: the cost is import-bound, not a race. `import()` memoises per specifier, so the first
  caller absorbs the whole cold load of discord.js inside its own 5000 ms budget.
- Focused test: time that single test on a warm box. It took 1488 ms against 0-5 ms for every
  neighbour — a 300-1000x outlier that no relay logic could explain. After the hoist: 1 ms.

## Implementation Steps

1. Confirm nothing depends on lazy loading: zero `vi.mock`, `vi.doMock`, `vi.resetModules`,
   `vi.unmock` in the file, which already statically imports other route modules.
2. Add one static top-level import with a comment explaining why it must not be moved back inline.
3. Remove the 11 identical dynamic-import lines from inside the test bodies.

## Required Fault Tests

- Test count unchanged at 535/51, proving no test was dropped or skipped by removing 11 imports.
- The previously failing test passes and is no longer a timing outlier.
- Client suite unaffected at 90/90.

## Acceptance Gates

- [x] Focused tests
- [x] Domain tests
- [x] V1 parity evidence (no production file touched)
- [x] Full required gate
- [ ] Independent verification
- [x] Rollback rehearsal (procedure verified; see ROLLBACK.md)

## Evidence

- `docs/modernization/evidence/FND-007/SUMMARY.md`
- `docs/modernization/evidence/FND-007/RESULTS.json`

## Rollback

```powershell
git checkout -- server/tests/bugfixes.test.js
```

Verification: the 1488 ms outlier returns. The defect reappearing is the proof.

## Risks / Decisions

- Risk IDs: resolves RISK-001
- ADR IDs: none
