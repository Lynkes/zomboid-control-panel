# Commands: FND-007

Record commands in execution order. Do not include secrets or full unbounded logs.

> **Filled in 2026-09-03 (kevin), transcribed from `RESULTS.json`'s `commands` array.** No
> per-command timestamp was captured, only the run's `started_at`/`finished_at` window
> (`2026-08-22T14:30:00Z`–`14:45:00Z`); UTC time left as `—` rather than invented.

| # | UTC time | CWD | Command | Exit | Duration ms | Result artifact/excerpt |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 1 | — | repo root | `npx vitest run server/tests/bugfixes.test.js --reporter=verbose` | 0 | 3300 | 93/93. The measurement that proves the fix: `forwards ordinary Say chat` now runs in 1 ms, down from 1488 ms on a warm box before FND-007 — the 300–1000x outlier is gone. |
| 2 | — | repo root | `npm run test:server` | 0 | 6100 | 535/535 across 51 files — count unchanged, so removing 11 dynamic imports dropped or skipped nothing. |
| 3 | — | repo root | `npm run lint:server` | 0 | 5400 | Clean. |
| 4 | — | `client/` | `npx vitest run` | 0 | 5900 | 90/90, unchanged. |
| 5 | — | `client/` | `tsc -b --pretty false; npm run build` | 0 | 15000 | No diagnostics; build succeeded. |

Full output larger than the evidence limit must be stored in a bounded, scrubbed artifact and linked. Record the SHA-256 of external evidence files.
