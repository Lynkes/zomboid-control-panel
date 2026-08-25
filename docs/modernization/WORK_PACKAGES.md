# Modernization Work Packages

| ID | Title | State | Owner | Worktree/branch | Dependencies | Owned paths | Reviewer | Evidence | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FND-001 | Fork baseline, program ledgers, evidence structure | **accepted** | coordinator | coordinator worktree (no branch) | none | `docs/modernization/{README,STATUS,STATUS_ARCHIVE,WORK_PACKAGES,DECISIONS,RISK_REGISTER,BASELINE,ROLLBACK}.md`, `docs/modernization/evidence/FND-001/**`, `scripts/modernization/**` | independent verifier | `evidence/FND-001/` | 2026-08-22 |
| FND-002 | API/Socket.IO contract inventory and golden fixtures | ready | unassigned | checkpoint e966fe9 done; worktree available | FND-001 | `docs/modernization/API_CONTRACT_INVENTORY.md`, `scripts/modernization/{inventory-api,capture-fixtures}.mjs`, `server/tests/contract-fixtures/**`, `evidence/FND-002/**` | — | — | 2026-08-22 |
| FND-003 | Minimal TypeScript-to-ESM build boundary proof | ready | unassigned | checkpoint e966fe9 done; worktree available | FND-001 | `server/modern-src/proof.ts`, `server/tests/modernBuild.test.js`, `tsconfig.modern.json`, `scripts/build-modern.mjs`, coordinator-owned package scripts/lockfile, `evidence/FND-003/**` | — | — | 2026-08-22 |
| FND-005 | Isolate the test data root (DISC-001 remediation) | **accepted** | coordinator | coordinator worktree | none (unblocks FND-001) | `vitest.config.js`, `server/tests/vitest.globalSetup.mjs`, `docs/modernization/evidence/FND-005/**` | independent verifier | `evidence/FND-005/` | 2026-08-22 |
| FND-006 | Harden the owned-path guard (DISC-002) + plan note | review | coordinator | coordinator worktree | none | `scripts/modernization/check-owned-paths.ps1`, `V2_MODERNIZATION_PLAN.md`, `docs/modernization/evidence/FND-006/**` | independent verifier | `evidence/FND-006/` | 2026-08-22 |
| FND-007 | Hoist discordBot import out of the per-test timeout (RISK-001) | review | coordinator | coordinator worktree | none | `server/tests/bugfixes.test.js`, `docs/modernization/evidence/FND-007/**` | independent verifier | `evidence/FND-007/` | 2026-08-22 |
| DB-001 | Data model ADR and normalization mapping | ready | unassigned | checkpoint e966fe9 done; worktree available | FND-001 | `docs/modernization/{DATA_MAPPING,ADR-DB-001}.md`, `server/tests/fixtures/modernization/**`, `evidence/DB-001/**` | — | — | 2026-08-22 |

The remaining 26 packages in the plan's catalog stay `planned` and are not restated here. The
dependency graph and catalog in `V2_MODERNIZATION_PLAN.md` are normative. This ledger tracks
execution state and reservations only.

Valid states: planned, ready, active, review, accepted, blocked, rejected.

## Reservation Notes

**RISK-005 is cleared.** The user-authorized local checkpoint `e966fe9` tracked the handoff files, so `create-worktree.ps1` will now find them and FND-002 / FND-003 / DB-001 are `ready`. They still must not START until FND-001 and FND-005 are accepted, and the plan requires a coordinator review at the Foundation boundary before dependent work begins.

**Historical note (resolved):** FND-002, FND-003, and DB-001 are the three packages the plan
permits to run in parallel after FND-001, but all three require separate worktrees, and
`WORKTREE_LIFECYCLE.md` prohibits worktree creation until a user-authorized local checkpoint commit
exists. Untracked handoff files do not appear in a new worktree, so an agent placed there today
would find neither the plan nor the toolkit. Tracked as RISK-005.

They are therefore marked `planned`, not `ready`: `ready` would imply they can be picked up, and
they cannot.

## Ownership Boundaries Already Fixed

Recorded now because ownership gaps are cheapest to prevent before two agents are in the tree:

- `server/modern-src/` is **not** owned wholesale by FND-003. FND-003 creates only `proof.ts` and
  the build files; each later subdirectory belongs to its catalog package.
- `server/modern-runtime/**` is generated output. It is never an ownership claim and is never
  hand-edited.
- Coordinator retains: `package.json`, both lockfiles, `server/index.js`, feature-flag
  registration, and all program ledgers. No implementation package edits these directly; they
  arrive as coordinator-owned hunks applied after implementation-owned paths.
- `data/db.example.json` is stale against the real schema (RISK-002). DB-001 must derive fixtures
  from `server/database/init.js` `defaultData`, not from the example file.
