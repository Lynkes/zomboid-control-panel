# Modernization Fork Agent Instructions

## Mandatory Startup

1. Work only in `D:\Projects\Zomboid_Control_Panel_Modernized`.
2. Read `V2_MODERNIZATION_PLAN.md` completely before searching or editing.
3. If `docs/modernization/STATUS.md` exists, read it next and resume only the recorded ready/active work package.
4. Run both handoff checks before selecting work:
   - `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernization\bootstrap-plan.ps1`
   - `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\modernization\validate-handoff.ps1`
5. Treat these paths as read-only references:
   - `D:\Zomboid_dev_panel\GitHub`
   - `D:\Projects\Zomboid_dev_panel V2`
6. Confirm the active work package, dependencies, owned paths, acceptance gate, and rollback before the first edit.

## Product Invariants

- Preserve the V1 React UI, navigation, routes, workflows, terminology, and responsive behavior.
- Preserve V1 Express API paths and existing request/response/error/Socket.IO contracts through adapters.
- V2 is a backend/reference source only. Never port its shell, pages, visual system, or navigation.
- V1 Express remains the sole HTTP host.
- PanelBridge and RCON retain their game-runtime authority.
- Agent support and OIDC remain optional.
- V1 local auth remains available as break-glass access.
- `data/db.json` remains authoritative until an explicitly accepted per-domain SQLite cutover.
- Never copy, overwrite, delete, or deploy a runtime `data/db.json`.

## Work Discipline

- Select only the next `ready` work package from the plan dependency graph.
- FND-001 runs in the coordinator worktree. Do not create implementation worktrees until the user authorizes a local-only checkpoint commit that tracks the handoff/toolkit and accepted FND-001 artifacts.
- Do not start dependent work in the same turn after accepting a package unless the user explicitly requests it.
- Before editing, state one falsifiable local hypothesis and the cheapest check that can disprove it.
- After the first edit, run the focused check before widening scope.
- Keep work-package files isolated. Concurrent implementation agents require separate worktrees and non-overlapping owned paths.
- The coordinator owns shared files: package manifests, lockfiles, `server/index.js`, feature-flag registration, plan/status/decision ledgers.
- Scaffold package evidence with `scripts/modernization/new-work-package.ps1`; copy specialized templates with `copy-package-template.ps1` only when required.
- Before review, run `validate-evidence.mjs` on RESULTS/PERF and `check-owned-paths.ps1` with the package's exact catalog paths.
- Add no abstraction unless it removes real complexity or matches the approved target architecture.
- Do not weaken tests, delete coverage, or report success after a guarded block did not execute.

## Evidence and Status

Every work package must update:

```text
docs/modernization/STATUS.md
docs/modernization/WORK_PACKAGES.md
docs/modernization/DECISIONS.md
docs/modernization/RISK_REGISTER.md
docs/modernization/evidence/<WP-ID>/
```

Evidence must include exact commands, exit codes, test counts, changed paths, known risks, and executable rollback instructions. A different agent must verify implementation packages before coordinator acceptance.

## Safety Boundaries

- Do not commit, push, tag, publish, create a remote, deploy, restart services, or touch Tower without explicit user approval.
- Do not install dependencies without recording why, the exact version, lockfile impact, and build/runtime consequences.
- Never expose passwords, tokens, cookies, recovery codes, RCON secrets, enrollment secrets, OIDC tokens, or raw DB backups in logs/evidence.
- Stop and escalate on contract incompatibility, unresolved authority conflicts, data-loss risk, secret-storage uncertainty, critical/high security findings, or overlapping file ownership.

## Baseline Gates

Run at phase boundaries and after integrations:

```powershell
npm run test:server
npm run lint:server
Push-Location client
npx vitest run
& .\node_modules\.bin\tsc.cmd -b --pretty false
npm run build
Pop-Location
git diff --check
```

Domain-specific gates in `V2_MODERNIZATION_PLAN.md` are additional and mandatory.

## Current Starting Point

- Baseline: V1 `v1.1.55`, commit `8642dc4`.
- Current phase: Phase 0 only.
- First work package: `FND-001`.
- Do not begin lifecycle replacement, SQLite implementation, agent enrollment, OIDC, or i18n until Foundation acceptance and user review.
