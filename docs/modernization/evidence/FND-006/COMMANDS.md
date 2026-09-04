# Commands: FND-006

Record commands in execution order. Do not include secrets or full unbounded logs.

> **Filled in 2026-09-03 (kevin), transcribed from `RESULTS.json`'s `commands` array.** No
> per-command timestamp was captured, only the run's `started_at`/`finished_at` window
> (`2026-08-22T14:20:00Z`–`14:40:00Z`); UTC time left as `—` rather than invented.

| # | UTC time | CWD | Command | Exit | Duration ms | Result artifact/excerpt |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 1 | — | repo root | `pwsh -File check-owned-paths.ps1 -Id FND-006 -AllowedPath scripts/modernization/,docs/modernization/` [ACCEPT case] | 0 | 900 | `PASS work-package=FND-006 changed=3`. The plan's documented `-File` comma form now works, because the script splits on commas itself — before this package the argument was silently discarded and PASS came from the internal fallback. |
| 2 | — | repo root | `pwsh -File check-owned-paths.ps1 -Id FND-006 -AllowedPath " , , "` [REFUSE case] | 1 | 800 | Throws `-AllowedPath produced no usable entries`. The test that matters most for a guard: feeding it something it must reject. (A first attempt misread `exit 0` — piped through `Select-Object`, which terminates the pipeline early and leaves a stale `$LASTEXITCODE`; re-run without a pipe gave the true exit 1.) |
| 3 | — | repo root | create `NOT_OWNED_PROBE.tmp`, then `pwsh -File check-owned-paths.ps1 -Id FND-006` [NOT-WEAKENED case] | 1 | 950 | `FAIL work-package=FND-006 / UNOWNED NOT_OWNED_PROBE.tmp`. Proves hardening the guard didn't make it permissive — a genuine ownership violation is still caught. Probe removed in a `finally` block. |
| 4 | — | repo root | `npm run test:server` | 0 | 6000 | 535/535 across 51 files. |
| 5 | — | repo root | `npm run lint:server` | 0 | 5400 | `--max-warnings=0`, clean. |
| 6 | — | repo root | `git diff --check` | 0 | 100 | Exit 0 after a line-ending repair — initially FAILED with trailing whitespace on every line of `DECISIONS.md` (CRLF from a scripted Python edit; see `known_risks` in `RESULTS.json`). |

Full output larger than the evidence limit must be stored in a bounded, scrubbed artifact and linked. Record the SHA-256 of external evidence files.
