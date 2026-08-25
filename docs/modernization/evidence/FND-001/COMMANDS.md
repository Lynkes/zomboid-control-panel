# Commands: FND-001

Record commands in execution order. Do not include secrets or full unbounded logs.

All exit codes were read directly from the invoking shell (`$LASTEXITCODE` immediately after the
native call). None was read through a pipe, because a piped gate reports the pipe's status rather
than the runner's.

CWD key: `R` = `D:\Projects\Zomboid_Control_Panel_Modernized`, `C` = `R\client`.

| # | UTC time | CWD | Command | Exit | Duration ms | Result artifact/excerpt |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 1 | 2026-08-22T12:56Z | R | `git rev-parse HEAD` / `git describe --exact-match --tags HEAD` | 0 | ~100 | `8642dc46...c88b`, `v1.1.55`; matches plan |
| 2 | 2026-08-22T12:56Z | R | `git remote -v` | 0 | ~80 | `v1-source` only; no `origin` |
| 3 | 2026-08-22T12:56Z | R | `git status --porcelain` | 0 | ~90 | 4 untracked handoff entries; no tracked changes |
| 4 | 2026-08-22T12:57Z | R | `bootstrap-plan.ps1` | 0 | 1200 | `RESULT=PASS`, `mode=baseline` |
| 5 | 2026-08-22T12:57Z | R | `validate-handoff.ps1` | 0 | 1500 | `RESULT=PASS`, `required-files=37`, `work-packages=30` |
| 6 | 2026-08-22T12:58Z | R | `initialize-program.ps1` | 0 | 900 | 8 ledgers created |
| 7 | 2026-08-22T12:58Z | R | `new-work-package.ps1 -Id FND-001` | 0 | 800 | 7 evidence files created; `RESULTS.json` deferred to completion |
| 8 | 2026-08-22T12:58Z | R | `bootstrap-plan.ps1` (resume) | 0 | 1100 | `mode=resume`, `status-current-sha` matches baseline |
| 9 | 2026-08-22T12:58Z | R | runtime capture -> `runtime.json` | 0 | ~300 | Node v24.12.0, npm 11.6.2, Git 2.47.1, Win NT 10.0.26200.0 X64 |
| 10 | 2026-08-22T12:59Z | R | `npm ci` | 0 | 10420 | 525 packages, 0 vulnerabilities |
| 11 | 2026-08-22T12:59Z | C | `npm ci` | 0 | 9827 | 407 packages, 0 vulnerabilities |
| 12 | 2026-08-22T12:59Z | R | `git diff --exit-code -- package-lock.json client/package-lock.json` | 0 | 120 | **Declared falsifier. Not disproven** — lockfiles byte-identical |
| 13 | 2026-08-22T12:59Z | R | `npm run test:server` **(cold)** | **1** | 24064 | **534 passed / 1 failed**; 5000 ms timeout in `bugfixes.test.js`; import 86.13 s. See RISK-001 |
| 14 | 2026-08-22T12:59Z | R | `npx vitest run server/tests/bugfixes.test.js` | 0 | 3270 | 93/93; import 1.39 s in isolation |
| 15 | 2026-08-22T13:00Z | R | `npm run test:server` **(warm)** | 0 | 6793 | **535/535**; import 35.40 s |
| 16 | 2026-08-22T13:00Z | R | `npm run lint:server` | 0 | 5639 | `--max-warnings=0`, no findings |
| 17 | 2026-08-22T13:00Z | C | `npx vitest run` | 0 | 36683 | 90/90 across 14 files |
| 18 | 2026-08-22T13:01Z | C | `tsc.cmd -b --pretty false` | 0 | 15145 | no diagnostics |
| 19 | 2026-08-22T13:01Z | C | `npm run build` | 0 | 27073 | built in 10.79 s; >500 kB chunk advisory (RISK-004) |
| 20 | 2026-08-22T13:02Z | R | `git diff --check` | 0 | 90 | clean; still zero tracked modifications |
| 21 | 2026-08-22T13:02Z | R | perf preconditions probe | 0 | ~200 | `paths.config.json` absent, temp roots absent, port 31955 free |
| 22 | 2026-08-22T13:02Z | R | isolated panel start + `measure-baseline.mjs` | 0 | 2100 | `SERVER_READY=200`; PERF.json written; cleanup verified |
| 23 | 2026-08-22T13:05Z | R | `validate-evidence.mjs --results --perf` | 0 | ~400 | `PASS results`, `PASS perf` |
| 24 | 2026-08-22T13:06Z | R | `check-owned-paths.ps1 -Id FND-001` | 0 | ~300 | see DIFF_SCOPE.md |

## Inventory probes (read-only, no side effects)

| # | Probe | Result |
| ---: | --- | --- |
| I1 | `server/routes/*.js` file count | 21 |
| I2 | `app.use("/api...")` in `server/index.js` | 55 total; 21 routers, 34 limiter mounts |
| I3 | `router.<method>(` declarations | 404 |
| I4 | distinct `.emit("...")` event names | 51 |
| I5 | `defaultData` collections in `server/database/init.js:57-76` | 19 |
| I6 | `data/db.example.json` top-level keys | 8 (3 not in schema, 14 schema keys missing) |

## Notes on excluded output

No full logs are stored. `npm ci` output, vitest per-test listings, and the Vite plugin timing
report were bounded to the excerpts in `RESULTS.json`. No secrets, tokens, cookies, RCON
passwords, or credential material appeared in any captured output; the only server route exercised
was unauthenticated `GET /api/auth/status`, whose response contains no secret material.
