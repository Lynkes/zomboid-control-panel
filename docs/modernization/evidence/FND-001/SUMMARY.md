# Evidence Summary: FND-001

- Work package: FND-001 — Fork baseline, program ledgers, and evidence structure
- Owner: coordinator
- Reviewer: independent verifier (see `VERIFICATION.md`)
- Base SHA: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`)
- Candidate SHA/diff hash: none — no commit created; awaiting user-authorized local checkpoint
- State: review

## Contract

- **Preserved V1 behavior:** all of it. No file under `server/`, `client/`, `data/`, or any other
  tracked path was created, modified, or deleted. Every V1 route, response shape, status code,
  Socket.IO event, PanelBridge/RCON path, and the lowdb data authority are untouched.
  `git status --porcelain` reports zero tracked modifications after the complete gate.
- **New capability:** documentation and evidence only — 8 program ledgers, 10 FND-001 evidence
  artifacts, a recorded toolchain, a performance sample, and the inventory starting point.
- **Feature flag/default:** none introduced. The seven `MODERN_*` flags are recorded as all-false
  in `RESULTS.json` to document intent; `FND-004` owns the actual registry.

## Diff Scope

- Declared paths: `docs/modernization/{8 ledgers}.md`, `docs/modernization/evidence/FND-001/**`,
  `scripts/modernization/**`
- Actual paths: 55 untracked entries — 37 pre-existing handoff/toolkit files plus 18 authored by
  FND-001. `check-owned-paths.ps1` returned `PASS ... changed=55`, exit 0.
- Unexpected paths: none

Full breakdown in `DIFF_SCOPE.md`.

## Results

- **Focused falsifier:** the hypothesis was *"the fork at `8642dc4` is green and reproducible
  without modification."* The cheapest disproof was `npm ci` in both trees followed by
  `git diff --exit-code -- package-lock.json client/package-lock.json`. Exit 0 — lockfiles
  byte-identical. **Not disproven.**
- **Domain gate:** n/a — FND-001 owns no runtime domain.
- **Full gate:** passed. Server 535/535, lint clean at `--max-warnings=0`, client 90/90 across 14
  files, `tsc -b` no diagnostics, client build succeeded, `git diff --check` clean.
- **Compatibility cells:** Windows native Node development only. The other five modes are
  inventoried in `BASELINE.md` but were not built or run — a deliberate boundary, since FND-001
  must not change production behavior and `DB-002` owns the packaging proof.
- **Fault tests:** n/a — there is no failure path to inject into a documentation package. The
  nearest equivalent, and it was exercised for real: the perf run's `finally` cleanup was verified
  to have removed `paths.config.json` and both temp roots.
- **Performance delta:** none to compare against; this *is* the baseline. `GET /api/auth/status`
  p50 0.716 ms, p95 1.225 ms, max 1.745 ms, RSS 61,427,712 B over 50 samples + 5 warmup.

Machine results: `RESULTS.json` (schema-valid), `PERF.json` (schema-valid) — both confirmed by
`validate-evidence.mjs`, exit 0.

## The one thing a reader should not skim

**The server suite failed on its first run and passed on its second, same command, same unmodified
tree.** Cold run: 534 passed, 1 failed, exit 1, import cost 86.13 s, with a hard 5000 ms timeout
tripping in `server/tests/bugfixes.test.js`. Warm run: 535 passed, exit 0, import cost 35.40 s. In
isolation the file passes 93/93 with import cost 1.39 s.

Both runs are recorded in `RESULTS.json` and `BASELINE.md`. Reporting only the passing run would
have made the baseline look deterministic when it demonstrably is not, and the next agent to hit
this cold on a fresh checkout would have had no way to know it was pre-existing. Filed as RISK-001
(high). The fix requires editing a test file, which FND-001's contract forbids.

## Security / Secrets

- **Threats exercised:** none deliberately; FND-001 adds no attack surface.
- **Redaction evidence:** no secret material was produced or captured. The only route exercised was
  unauthenticated `GET /api/auth/status`. No token, password, cookie, recovery code, RCON secret,
  or credential appears in any evidence file. `runtime.json` contains tool versions only.
- **Open findings:** none.

## Provenance

`PROVENANCE.md` — explicit nil return. No V2 code or concept was ported; the V2 and V1 reference
trees were never read during this package and neither was modified. No dependency was added, and
both lockfiles are provably unchanged.

## Risks and Decisions

- Risk IDs: RISK-001 (high, cold-run flake), RISK-002 (high, `db.example.json` stale against
  `defaultData`), RISK-003 (high, single-route perf coverage), RISK-004 (medium, unmeasured bundle
  size), RISK-005 (medium, worktrees blocked until checkpoint)
- ADR IDs: none. FND-001 made no architectural decision — it recorded state. The first ADRs belong
  to `DB-001` (data model) and `AUT-001` (identity).

## Rollback

`ROLLBACK.md`. Deletes only the 18 authored files; no git operation, because nothing was staged or
committed. Rehearsal **not** performed, and the reason is stated rather than hidden: running it
would delete the evidence under review. Its preconditions are verified and the success signal is
observable (`bootstrap-plan.ps1` flips from `mode=resume` back to `mode=baseline`).

## The blocking defect — DISC-001 / RISK-006

**The plan's mandatory baseline gate breaks the plan's mandatory preflight.**
`server/database/init.js` runs a bare top-level `for` loop of `fs.mkdirSync` at lines 43-50, so
**merely importing the module** creates `data/` and `data/backups/` and writes a default
`data/db.json` whenever no `paths.config.json` override is present. The FND-001 clean-room
sequence wraps only the perf step in that override, not `npm run test:server`. The result:
`bootstrap-plan.ps1` throws `data/db.json must not exist in the modernization fork baseline.` on
the next run, so **the documented sequence cannot be executed twice.**

This was found independently twice — by the coordinator when a post-ledger re-run threw, and by the
independent verifier before reading this file. The verifier located the exact mechanism; the
coordinator's first reading had named only the trigger.

It is a plan defect requiring a user decision, not a coordinator cleanup, and it is **the reason
this package is not being recommended for acceptance.** Four options and a recommendation are in
`DECISIONS.md` under DISC-001. Option 1 was withdrawn on discovering `init.js:42` records that
`db.json` holds an RCON password and JWT secret — the guard protects real secret material and must
not be softened.

## Recommendation

**BLOCK** — pending a user decision on DISC-001.

Everything FND-001 was contracted to produce exists and is sound: program ledgers, baseline runtime
facts, inventory starting point, performance sample, evidence structure. Production behavior is
provably unchanged, confirmed independently by the verifier (`git status --porcelain` clean of
tracked entries; `check-owned-paths.ps1`, `validate-handoff.ps1`, and `validate-evidence.mjs` all
exit 0). The verifier also recounted every inventory figure — 21 route files, 21 router mounts, 404
handlers, 51 socket events, 19 collections — and all matched exactly.

But a package cannot be accepted while the preflight that gates it fails, and it fails by design of
the plan rather than by any error in this work. Accepting it would mean signing off a green gate
that cannot be reproduced on a second run.

**Corrections applied after verification, both found by the verifier and both real:** RISK-005 was
missing from `RESULTS.json.known_risks`, and this summary did not disclose DISC-001 at all. The
second is the more serious of the two — the evidence was recording the finding while the summary a
reviewer reads first stayed silent about it.
