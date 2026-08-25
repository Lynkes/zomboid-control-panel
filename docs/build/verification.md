# Build verification — 2026-08-22

Requested by god: nobody had checked that this application still builds tonight, ~70
commits in, with every existing gate running tests rather than a build. This is a status
report, not a fix — per the task boundary, in-flight files that broke a build were named,
not edited.

Environment: Windows 11, Node v24.12.0, npm 11.6.2, repo at commit `49263c86` (HEAD at time
of writing), panel version 1.1.55.

## Update — end-to-end result (same evening, after Phyllis's commit `7344c47`)

The `Debug.tsx` blocker in §1 was resolved by Phyllis's commit; the client build (and
therefore the rest of the pipeline) is unblocked. This section is the answer to the
follow-up question: does `node build.js` work **in sequence, from a clean start** — not
just as isolated stages (§2 below proved the stages separately; this proves the whole
pipeline together).

```
$ node build.js
Building client...              (tsc -b && vite build — 2.73s, no errors)
Client built successfully
Building server bundle...       (esbuild → dist-exe/server.cjs, PanelBridge.lua v1.7.38 embedded)
Server bundled successfully
Creating executables for: win   (npx pkg — two expected non-fatal warnings, see §2)
Creating release package...
Release package created successfully
```
Wall clock: **37.7s** end to end. Exit code: **0**.

**Artifact produced**: `release/ZomboidControlPanel.exe`, exactly **66,411,729 bytes**
(63.3 MiB), sha256 `907c25a0ed57ca704b65803e5a03d3ff6dce8b9004163544264118e06296fba7`
(also written to `release/checksums.txt` and `release/release-manifest.json` by the build
itself), plus the full release tree: `client/dist/`, `data/` (scaffold only —
`db.example.json`, `README.txt`, empty `backups/`), `logs/`, `pz-mod/`,
`browser-extension/` (+ its zip), `sql-wasm.wasm`, `Start.bat`, `start.sh`,
`zomboid-panel.service`, `docker-compose.install.yml`, `README.txt`.

**Does the .exe actually launch?** Yes, verified live — with one real wrinkle worth
recording. Launching it directly (`.\ZomboidControlPanel.exe`, no env overrides) does
**not** run the server in that process: `server/index.js`'s own
`maybeReexecViaSupervisor()` (lines 69–109) detects it's a packaged Windows build with no
`PANEL_SUPERVISOR_V=2` set, so it spawns `Start.bat` in a new detached console and exits(0)
immediately — by design, so every future in-app update always goes through the supervisor's
rename-and-relaunch path. Running it that way three times in a row (not realizing the first
call had already hand off to a persistent supervised instance) left three orphaned
`cmd /K Start.bat` windows behind, one of which logged a real
`Apply: ERROR could not back up running .exe (still locked?)` — an artifact of stacking
multiple direct launches on top of each other, not a defect in a normal single launch or
double-click. All three were found (`Get-CimInstance Win32_Process` showing
`cmd.exe /K ...\Start.bat`) and killed during cleanup.

For a clean, single-process check, relaunched with the documented escape hatch
(`PANEL_NO_SUPERVISOR=1`), which skips the hand-off and runs the server directly in the
foreground as normal for a service/automated context:
```
$ PORT=3097 PANEL_NO_SUPERVISOR=1 .\ZomboidControlPanel.exe
  ╔═════════════════════════════════════════════════╗
  ║         Zomboid Control Panel  v1.1.55          ║
  ╚═════════════════════════════════════════════════╝
16:32:10 • [DB] Running DB migrations: v1 → v3
16:32:10 • [Auth] Generated new JWT secret
16:32:10 • [Panel] No users found — first-run setup required
...
  Local:    http://localhost:3097
```
```
$ curl http://localhost:3097/api/health
{"status":"ok","version":"1.1.55","timestamp":"2026-08-22T20:32:18.417Z"}
$ curl http://localhost:3097/api/auth/status
{"needsSetup":true,"authEnabled":false}
$ curl -I http://localhost:3097/
200, text/html — serves the built client/dist correctly
```
Real DB migration ran, real JWT secret generated, real HTTP responses from the actual
compiled binary — not inferred from the bundle succeeding. Killed the process afterward,
then deleted both `dist-exe/` and `release/` (gitignored, nothing to commit).

**Answer to the actual question asked**: yes — from a clean `dist-exe`/`release`, one
command (`node build.js`), 38 seconds, produces a working, launchable, HTTP-serving
Windows executable. Sequencing the steps together doesn't surface anything the isolated
runs in §2 missed; the one real finding (repeated direct-launches contending with the
supervisor hand-off) is about *how this binary is invoked for scripted/automated testing*,
not about the pipeline or the shipped artifact.

## 1. Client production build — `npm run build` (= `tsc -b && vite build`)

**Result: FAILS today.** Root cause is in-flight, uncommitted work, not a real regression.

```
$ cd client && npm run build
> tsc -b && vite build
src/pages/Debug.tsx(3320,56): error TS6133: 'unit' is declared but its value is never read.
```
Exit code: 1.

This moved during the investigation — earlier in the same session the failure set also
included `src/components/templates/TemplateDiffList.tsx(55,9)` and two more lines in
`Debug.tsx` (`getLevelLabel`, `getSourceLabel`), which cleared on their own as another
agent kept editing. Before an even earlier check, `src/pages/Settings.tsx` was the one
blocking the build; that also cleared on its own. **Established that this is someone
else's in-progress work, not a defect at HEAD**, by checking:
```
$ git status --short client/src/pages/Debug.tsx
 M client/src/pages/Debug.tsx        # uncommitted, 922 changed lines
$ git show HEAD:client/src/pages/Debug.tsx | sed -n '3315,3325p'
                                          {p.access && p.access !== "None" && (
                                            <span className="text-warning ml-1">
                                              · {p.access}
                                            </span>
                                          )}
                                        </div>
                                      ))}
                                      {r.count !== null &&
```
The code at that line in the committed HEAD version doesn't contain the `unit` variable at
all — it doesn't exist yet in what's on `main`. **Do not edit `Debug.tsx`** — this is an
active translation pass (Stanley/Jim's ops-page territory) that will resolve itself as that
work finishes; editing it now would very likely just collide with an in-progress save.

**Vite's bundler step alone (`npx vite build`, bypassing `tsc -b`) succeeds cleanly** —
confirms `tsc -b`'s isolated type-checker (which enforces `noUnusedLocals`/`noUnusedParameters`)
is strictly more sensitive here than what esbuild's transpile-only pass, ESLint, or Vitest
catch, exactly as flagged in the task brief. `npm run lint` (ESLint) is clean of errors
right now (16 pre-existing warnings, 0 errors, none related to Debug.tsx or
TemplateDiffList.tsx).

**Action for whoever picks this up next**: re-run `npm run build` once Debug.tsx's
translation pass lands — nothing else needs fixing on the client side.

## 2. `node build.js` and its `--windows` / `--linux` variants

Read `build.js` in full before running anything, per the task instruction. What it
actually does, in order:
1. Cleans and recreates `dist-exe/` and `release/`.
2. Runs `npm run build` inside `client/` via `execSync` — **the whole script exits(1)
   immediately if this fails**, before touching the server at all.
3. Bundles `server/index.js` into a single CJS file (`dist-exe/server.cjs`) via esbuild,
   embedding the panel version and `PanelBridge.lua` (base64) as compile-time constants.
   `@aws-sdk/client-s3` and all `*.node` native addons are marked external.
4. Writes a `dist-exe/package.json` pkg config targeting `node22-win-x64` and/or
   `node22-linux-x64` depending on `--windows`/`--linux`/`--all` (default: host platform,
   i.e. `win` on this machine).
5. Runs `npx pkg . --compress GZip --public --public-packages "*"` inside `dist-exe/` to
   produce a standalone executable per target (`@yao-pkg/pkg`, the maintained fork).
6. Copies the binary + `client/dist/` + `data/`, `logs/`, `pz-mod/`, browser extension,
   `sql-wasm.wasm`, `Start.bat`/`start.sh`, checksums, and a release manifest into
   `release/`.

**Result: all three invocations (`node build.js`, `--windows`, `--linux`) fail identically**,
at step 2, for the exact same reason as §1 — `execSync` throws on the client build's
non-zero exit, `build.js` catches it, prints `Client build failed: Command failed: npm run
build`, and calls `process.exit(1)`. The `--windows`/`--linux` flags only change the pkg
target list computed in step 4, which is never reached. Exit code 1 for all three.

**Supplementary check — steps 3–5 in isolation**, to answer whether anything *past* the
client-build blocker is itself broken (worth knowing independently of Debug.tsx's fate):
manually ran the exact esbuild call from `build.js` (step 3), then `npx pkg` for both
`node22-win-x64` and `node22-linux-x64` (step 5) against the resulting bundle.

- esbuild step: succeeds, produces a 12.3 MB `server.cjs`. Two non-fatal warnings, both
  expected from the source's own comments: a dynamic `require('mod')` and the
  intentionally-external `@aws-sdk/client-s3`/native-addon packages (`zlib-sync`) not being
  found — these are optional, try/catch-guarded at their call sites per the code.
- `pkg` for `node22-win-x64`: succeeds, produces a working 66 MB
  `zomboid-control-panel.exe`. Same two warnings.
- `pkg` for `node22-linux-x64` (cross-packaged from Windows): succeeds, produces an 83 MB
  `zomboid-control-panel` binary. Same two warnings. This does **not** prove the binary
  runs correctly on an actual Linux host (no Linux machine available here to execute it —
  see §3 for the actual Linux-specific risk, which lives in the *build* step, not this
  packaging step) — pkg's cross-target packaging just fetches a matching prebuilt Node and
  wraps the already-bundled, pure-JS `server.cjs`, so it isn't exercising any
  platform-specific native code at packaging time.
- Cleaned up both throwaway `dist-exe/`/`release/` trees afterward (already gitignored,
  not part of any commit).

**Bottom line: the server-bundle-and-package pipeline (steps 3–5) is healthy today.**
The only thing standing between `node build.js` and a real release artifact tonight is
Debug.tsx's in-flight translation pass finishing.

## 3. The package-lock.json Linux/libc question

Task: verify whether `package-lock.json` is missing glibc/musl metadata for
platform-specific optional dependencies, which would fail a Linux/Docker build with a
missing-binary error that never reproduces on Windows. **Explicitly not asked to fix this
myself, and did not touch the lockfile.**

**What I found, and how:**

`package-lock.json` is `lockfileVersion: 3` (a version that supports a per-package `libc`
field). Directly inspected the `packages` map for every optional, platform-tagged entry
(52 total). Confirmed by property presence check (not just missing from a printed
summary) that **none of the Linux gnu/musl split packages carry a `libc` field at all** —
e.g. `node_modules/@rolldown/binding-linux-x64-gnu` and
`node_modules/@rolldown/binding-linux-x64-musl` both have `os: ["linux"], cpu: ["x64"]`
and no `libc` key whatsoever; same for `lightningcss-linux-x64-gnu` /
`-musl`. So: **the underlying condition described in the old note is real and still
present today** — this is not a stale concern.

**But it is already worked around, for the one place that ships a Linux build**: the
repo's own `Dockerfile` explicitly documents this exact issue and avoids it —
```
# Install client dependencies (includes devDeps for build tooling).
# We use `npm install` rather than `npm ci` because esbuild/@emnapi ship
# OS-specific optional binaries; a Windows-generated lockfile won't contain
# the linux/amd64 + linux/arm64 entries that `npm ci` requires.
RUN cd client && npm install --no-audit --prefer-offline --include=optional
```
(and the identical reasoning again for the server-deps stage). `npm install` re-resolves
optional platform dependencies against the current host at install time; unlike `npm ci`,
it doesn't require the lockfile to already contain a platform-correct entry for the
machine it's running on. **So the Docker/Linux release path is not exposed** — it was
already fixed, just not by touching the lockfile.

**Where it is still a live, unaddressed exposure**: three GitHub Actions workflows still
use `npm ci` on `ubuntu-latest` / a Linux matrix — exactly the command the Dockerfile's own
comment calls fragile for this reason:
- `.github/workflows/ci.yml` — both the `server` job (root `npm ci`) and the `client` job
  (`npm ci` in `client/`).
- `.github/workflows/demo-pages.yml` — `npm ci --no-audit`.
- `.github/workflows/release-artifacts.yml` — `npm ci --no-audit`, twice, on a matrix that
  includes `ubuntu-22.04`.

**What I could not verify**: whether this has actually caused a real CI failure. There's
no git remote configured in this checkout (by design — this hive never pushes/fetches) and
no GitHub auth available from here, so I couldn't pull real run history for `ci.yml` to see
if `npm ci` has actually broken on `ubuntu-latest`, or if `ubuntu-latest`'s glibc userland
happens to be tolerant of the missing field in practice (e.g. if the absence of a `libc` key
means "no constraint" rather than "wrong platform," `npm ci` may just install both the gnu
and musl variants wastefully rather than failing outright — I don't have a way to confirm
which behavior actually occurs without running it on a real Linux host, which I don't have
access to). Runtime risk to the *shipped binary* is separately ruled out regardless: esbuild,
vite, rollup/rolldown, and lightningcss are all `devDependencies` only (checked
`package.json`/`client/package.json` directly) — the packaged executable never invokes them,
so an end user's release binary can't be affected by this even if the concern is real.

**Recommendation, not an action**: if this is worth closing out, the smallest fix that
doesn't touch the lockfile is applying the Dockerfile's own precedent (`npm install
--include=optional` instead of `npm ci`) to the three CI workflows above — but that's a
`.github/workflows/*.yml` change, and whether the CI job's reproducibility guarantees
(the whole point of `npm ci`) are worth trading for that is a call for whoever owns CI, not
mine to make unilaterally.

## Summary

| Check | Result |
|---|---|
| `npm run build` (client) | Failed at first check — 1 remaining `noUnusedLocals` error in uncommitted `Debug.tsx` (in-flight translation work, not at HEAD). **Resolved once Phyllis's `7344c47` landed** — now builds clean in 2.7s. |
| `node build.js` (default, i.e. Windows on this host) | **Verified working end-to-end from a clean start**: 37.7s, exit 0, produces a real, launchable, HTTP-serving `ZomboidControlPanel.exe` (66,411,729 bytes, sha256 `907c25a0...`). Isolated stage checks (esbuild bundle, `pkg` for both win and linux targets) were also independently healthy before the client blocker cleared. |
| `node build.js --linux` | Packaging step alone verified healthy (produces an 83 MB binary via `pkg` cross-compilation from Windows) — not run end-to-end and not executed, since there's no Linux host here to run a Linux binary on. |
| `package-lock.json` Linux/libc gap | **Real, confirmed structurally** (no `libc` field on gnu/musl split optional deps). **Already neutralized for Docker** via `npm install` instead of `npm ci` (see Dockerfile comments). **Still live in 3 GitHub Actions workflows** that use `npm ci` on Linux — unverified whether it has actually broken them (no remote/CI access from here). Zero runtime risk to the shipped binary either way (the affected packages are build-only devDependencies). No lockfile change made, per instruction. |
