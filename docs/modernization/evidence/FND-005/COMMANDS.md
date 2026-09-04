# Commands: FND-005

Record commands in execution order. Do not include secrets or full unbounded logs.

> **Filled in 2026-09-03 (kevin), transcribed from `RESULTS.json`'s `commands` array (which this
> file was never populated from at the time).** `RESULTS.json` records only the run's overall
> `started_at`/`finished_at` window (`2026-08-22T13:30:00Z`–`13:37:00Z`), not a timestamp per
> command, so the UTC time column below is left as `—` rather than inventing false precision.

| # | UTC time | CWD | Command | Exit | Duration ms | Result artifact/excerpt |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 1 | — | repo root | cleanup + `npm run test:server` (falsifier: artifacts stop AND discovery count unchanged) | 0 | 4730 | `PRE: db.json=False backups=False logs=False pathsconfig=False`. 535/535 across 51 files. `POST:` all still `False`. Count unchanged from FND-001 baseline. |
| 2 | — | repo root | `pwsh -File .\scripts\modernization\bootstrap-plan.ps1` (immediately after the gate run) | 0 | 1200 | `PASS runtime-db-absent / RESULT=PASS` — threw exit 1 at this exact point before FND-005. |
| 3 | — | repo root | `npm run lint:server` | 0 | 5200 | `--max-warnings=0`, no findings; confirms the new `vitest.globalSetup.mjs` passes project lint rules. |
| 4 | — | `client/` | `npx vitest run` (client suite must not inherit the new root config) | 0 | 5850 | 90/90 across 14 files — unchanged from baseline, confirming no leakage into `client/vite.config.ts`. |
| 5 | — | `client/` | `.\node_modules\.bin\tsc.cmd -b --pretty false` | 0 | 3100 | No diagnostics. |
| 6 | — | `client/` | `npm run build` | 0 | 12000 | Build succeeded; same >500 kB chunk advisory as baseline (RISK-004), unchanged. |
| 7 | — | repo root | `git diff --check` | 0 | 90 | Clean. |
| 8 | — | repo root | `npm run test:server` (**second** consecutive run) then `bootstrap-plan.ps1` — the actual defect-closure proof | 0 | 6000 | 535/535, exit 0; then `PASS runtime-db-absent / RESULT=PASS`, exit 0. This is the sequence that threw before FND-005 and now doesn't. |

Full output larger than the evidence limit must be stored in a bounded, scrubbed artifact and linked. Record the SHA-256 of external evidence files.
