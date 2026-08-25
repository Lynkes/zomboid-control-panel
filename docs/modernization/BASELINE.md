# Modernization Baseline

## Source

- Fork path: `D:\Projects\Zomboid_Control_Panel_Modernized`
- Baseline commit: `8642dc467938a47ca8aac76fc44fc1875446c88b`
- Baseline tag: `v1.1.55`
- Reference remote: `v1-source` (no `origin`; there is no default push target)
- V1 source reference: `D:\Zomboid_dev_panel\GitHub` (read-only)
- V2 reference: `D:\Projects\Zomboid_dev_panel V2` (read-only)

Captured at `2026-08-22T12:58:19Z`. Source of record: `evidence/FND-001/runtime.json`.

## Toolchain

| Tool | Version |
| --- | --- |
| OS/architecture | Microsoft Windows NT 10.0.26200.0 / X64 |
| Git | 2.47.1.windows.2 |
| Node | v24.12.0 |
| npm | 11.6.2 |

## Deployment Modes

All six modes in the plan's compatibility matrix are present in the fork at baseline. FND-001
records their existence and build entry points only; **none has been built or executed** beyond
the Windows native Node path used for the performance sample.

| Mode | Entry point | Exercised by FND-001 |
| --- | --- | --- |
| Windows native Node development | `npm start` -> `node server/index.js` | Yes — isolated instance on port 31955 |
| Windows packaged executable | `npm run build:exe:windows` -> `build.js --windows` | No |
| Linux native Node/service | `node server/index.js` | No |
| Linux packaged binary | `npm run build:exe:linux` -> `build.js --linux` | No |
| Docker standard panel | `Dockerfile`, `docker-compose.yml`, `docker/entrypoint.sh` | No |
| Docker all-in-one PZ | `docker/all-in-one/` | No |
| Unraid template | `docker/unraid/` | No |

The five unexercised modes are a deliberate scope boundary, not an omission: FND-001 must not
modify production behavior, and building or running them is neither required by its contract nor
free of side effects. `DB-002` owns the packaging/native-binding proof.

## Baseline Gate

Every exit code below was captured directly from the invoking shell, never through a pipe.

| Command | Exit | Test count/duration | Evidence |
| --- | ---: | --- | --- |
| `npm ci` (root) | 0 | 525 packages, 10.4s | RESULTS.json |
| `npm ci` (client) | 0 | 407 packages, 9.8s | RESULTS.json |
| `git diff --exit-code -- package-lock.json client/package-lock.json` | 0 | lockfiles unchanged | RESULTS.json |
| `npm run test:server` **(run 1, cold)** | **1** | **534 passed, 1 failed, 21.31s** | RISK-001 |
| `npx vitest run server/tests/bugfixes.test.js` | 0 | 93 passed, 3.27s | RISK-001 |
| `npm run test:server` **(run 2, warm)** | 0 | 535 passed, 5.93s | RESULTS.json |
| `npm run lint:server` | 0 | no findings, 5.6s | RESULTS.json |
| `npx vitest run` (client) | 0 | 90 passed / 14 files, 34.0s | RESULTS.json |
| `tsc -b --pretty false` (client) | 0 | no diagnostics, 15.1s | RESULTS.json |
| `npm run build` (client) | 0 | built in 10.79s | RESULTS.json |
| `git diff --check` | 0 | clean | RESULTS.json |
| `measure-baseline.mjs` | 0 | 50 samples + 5 warmup | PERF.json |

**The gate is green, but it was not green on the first attempt.** Run 1 and run 2 are the same
command against the same unmodified tree with opposite outcomes. Both are recorded. Reporting only
run 2 would have made the baseline look deterministic when it is not.

## Performance Baseline

| Route | Method | Samples | p50 | p95 | max | RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `auth-status` | GET `/api/auth/status` | 50 (+5 warmup) | 0.716 ms | 1.225 ms | 1.745 ms | 61,427,712 B |

Measured against an isolated instance: port 31955, temporary `paths.config.json`, data and log
roots under `%TEMP%`. All four were removed in a `finally` block and their removal verified.
No runtime `data/db.json` was created, read, or written.

**Coverage limit, stated plainly:** this is one unauthenticated, non-I/O route. It anchors the
plan's "contract validation adds no more than 5 ms p95" budget and nothing else. See RISK-003.

## API / DB / Route Counts

These are the FND-001 **starting point**. `FND-002` owns the authoritative per-route inventory;
these numbers are counts, not a contract.

- **API route modules:** 21 files under `server/routes/`
- **Express mounts under `/api`:** 55 `app.use` calls in `server/index.js`, of which **21 are
  routers** and the remainder are rate limiters (`strictLimiter`, `rconLimiter`,
  `collectionMutationLimiter`, `panelBridgeCommandLimiter`, global `apiLimiter`). The limiter
  mounts are part of the public contract's behavior and must not be dropped when routes move.
- **Route handlers:** 404 `router.<method>(` declarations across `server/routes/*.js`
- **Socket.IO events:** 51 distinct emitted event names
- **DB collections:** **19**, authoritative source `server/database/init.js` `defaultData`
  (lines 57-76). This matches the plan's V1 Collection Mapping table exactly.
- **Client pages:** owned by FND-002; not counted here.

### DB shape caveat

`data/db.example.json` is **not** the schema authority and disagrees with it:

| Direction | Count | Keys |
| --- | ---: | --- |
| In example, absent from schema | 3 | `activity_log`, `mods`, `active_server_id` |
| In schema, absent from example | 14 | `schedule_history`, `player_logs`, `tracked_mods`, `ignored_mods`, `ignored_mod_pairs`, `player_notes`, `player_stats`, `mod_presets`, `user_templates`, `steamid_bans`, `performance_history`, `bridge_logs`, `discord_webhooks`, `users` |

Recorded as RISK-002. `DB-001`/`DB-003` must derive fixtures from `defaultData`, not from the
example file.

## Known Baseline Risks

Pre-existing conditions are recorded here so they are never mistaken for modernization
regressions.

| Risk | Summary |
| --- | --- |
| RISK-001 | Cold-run test failure; baseline green but not deterministic on first run |
| RISK-002 | `db.example.json` stale against `defaultData` |
| RISK-003 | Performance baseline covers one route only |
| RISK-004 | Client bundle >500 kB chunk advisory, no recorded byte figure |

See `RISK_REGISTER.md` for scoring, owners, and triggers.
