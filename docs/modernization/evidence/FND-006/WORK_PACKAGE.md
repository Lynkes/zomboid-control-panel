# FND-006: Harden the owned-path guard (DISC-002) and correct the plan text

- State: review
- Owner: coordinator
- Worktree: coordinator worktree (no branch)
- Branch: none
- Dependencies: none
- Reviewer: independent verifier

## Contract Preserved

All V1 behavior. No production file is touched. The changes are one toolkit script and one
documentation note.

## New Capability

`check-owned-paths.ps1` splits `-AllowedPath` on commas and refuses an argument that yields no
usable entries, instead of silently proceeding with an empty allow-list and printing PASS.

## Owned Paths

- `scripts/modernization/check-owned-paths.ps1`
- `V2_MODERNIZATION_PLAN.md` (a single explanatory note beside the documented command)
- `docs/modernization/evidence/FND-006/**`

## Explicit Non-Goals

- Not changing `bootstrap-plan.ps1`. The DISC-002b claim against it was withdrawn as my own error.
- Not adding a `*.md text eol=lf` rule to `.gitattributes`. That would close RISK-011, but it is a
  repo-wide change outside this package's ownership.
- Not rewriting the plan's documented command. With the split in place it works correctly; a note
  explaining why the split must stay is the durable fix.

## Hypothesis and Cheapest Falsifier

- Hypothesis: `pwsh -File` binds `-AllowedPath a,b` as one string, so the guard never evaluates it.
- Focused test: `pwsh -File probe.ps1 -AllowedPath a,b,c` and print the element count. It printed
  `elements=1`. Confirmed, not inferred.

## Implementation Steps

1. Split each `-AllowedPath` element on commas, trim, and drop empties.
2. Throw when the resulting set is empty, so an unusable argument is loud instead of silent.
3. Add a note beside the plan's documented command explaining why the split exists.

## Required Fault Tests

- Accept: the plan's `-File` comma form returns PASS, exit 0.
- Refuse: `-AllowedPath " , , "` throws, exit 1.
- Not weakened: with a genuinely unowned file present, the guard still FAILs, exit 1. This is the
  test that matters most, because hardening a guard risks making it permissive.

## Acceptance Gates

- [x] Focused tests
- [x] Domain tests
- [x] V1 parity evidence (no production file touched; 535/535 unchanged)
- [x] Full required gate
- [ ] Independent verification
- [x] Rollback rehearsal (procedure verified; see ROLLBACK.md)

## Evidence

- `docs/modernization/evidence/FND-006/SUMMARY.md`
- `docs/modernization/evidence/FND-006/RESULTS.json`

## Rollback

```powershell
git checkout -- scripts/modernization/check-owned-paths.ps1 V2_MODERNIZATION_PLAN.md
```

Verification: `-AllowedPath " , , "` returns exit 0 again instead of throwing. The defect
reappearing is the proof.

## Risks / Decisions

- Risk IDs: resolves RISK-007; records RISK-011 (scripted CRLF edits break `git diff --check`)
- ADR IDs: none. DISC-002 is a plan discrepancy, not an architectural decision.
