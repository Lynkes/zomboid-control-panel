# Rollback Manifest: FND-007

> **Filled in 2026-09-03 (kevin) — this file was an unfilled template.** Content transcribed from
> `SUMMARY.md`'s own Rollback section (already correct there) and `WORK_PACKAGE.md`.

- Feature flag: none — test-file behavior, not a runtime feature
- Pre-change SHA: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`)
- Candidate SHA: `8f4ec5f249b36ffe9ede5e4a18aca5a2561b8fdc`
- Data authority before: n/a — no production data path touched
- Data authority after: **unchanged**

## Backups

| Artifact | Backup path | SHA-256 | Restore target | Verified |
| --- | --- | --- | --- | --- |
| _none required_ | — | — | — | — |

`server/tests/bugfixes.test.js` existed before this package; the change is an in-place edit, not a
new file, so `git checkout --` is a complete restore with no separate backup needed.

## File Rollback

```powershell
git checkout -- server/tests/bugfixes.test.js
```

Verification that the old (slow, non-deterministic) behavior is back:

```powershell
npx vitest run server/tests/bugfixes.test.js --reporter=verbose
# Before FND-007: "forwards ordinary Say chat" ~1488ms on a warm box (worse cold). After a
# successful rollback: the outlier returns. The 1488ms figure returning IS the proof.
```

## Data Rollback Rule

Preserve, never delete. No modern database exists; this package touches no data path at all.

## Post-Rollback Verification

- [x] V1 workflow smoke test — full gate was green on this exact tree before commit (`RESULTS.json`)
- [x] Data authority confirmed — n/a, no data path touched
- [x] Evidence captured — `RESULTS.json`, `SUMMARY.md`
- [ ] Rollback commands executed — not exercised; per `SUMMARY.md`'s own reasoning for the sibling
      FND-001/FND-005/FND-006 packages, running it would reintroduce a known, real defect (the
      1488 ms cold-import timeout risk) into a tree other packages/agents depend on
