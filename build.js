import esbuild from "esbuild";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const distDir = "./dist-exe";
const releaseDir = "./release";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanDir(dir, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 1000,
        });
      }
      return true;
    } catch (error) {
      if (i === maxRetries - 1) {
        console.warn(`Could not fully clean ${dir}: ${error.message}`);
        console.warn("Attempting to continue anyway...");
        return false;
      }
      console.log(`Retry ${i + 1}/${maxRetries} for ${dir}...`);
      await delay(2000);
    }
  }
  return false;
}

function resolveTargets(args) {
  const wantsAll = args.includes("--all");
  const wantsWindows = args.includes("--windows");
  const wantsLinux = args.includes("--linux");

  if (wantsAll || (wantsWindows && wantsLinux)) {
    return ["win", "linux"];
  }

  if (wantsWindows) {
    return ["win"];
  }

  if (wantsLinux) {
    return ["linux"];
  }

  return [process.platform === "win32" ? "win" : "linux"];
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function resolveBuiltBinaryPath(target) {
  const candidates =
    target === "linux"
      ? [
          "./dist-exe/zomboid-control-panel",
          "./dist-exe/zomboid-control-panel-linux",
        ]
      : [
          "./dist-exe/zomboid-control-panel.exe",
          "./dist-exe/zomboid-control-panel-win.exe",
        ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function writeReleaseReadme() {
  const readme = `# Zomboid Control Panel

## Quick Start

### Windows
1. Extract ZomboidControlPanel-windows.zip
2. Run Start.bat (or double-click ZomboidControlPanel.exe)
3. Open your browser to http://localhost:3001
4. Configure your server paths in Settings

### Linux (Ubuntu / Debian)
1. Extract: tar xzf ZomboidControlPanel-linux.tar.gz
   (Execute permissions are preserved in the archive)
2. Run: ./start.sh  (or ./ZomboidControlPanel directly)
3. Open your browser to http://localhost:3001
4. Configure your server paths in Settings

### Installing a new PZ server from the panel
When using the included Linux systemd service, enter this exact folder in the
setup wizard:

  /opt/zomboid-panel/data/pzserver

Create it once before using the wizard:

  sudo -u pzuser mkdir -p /opt/zomboid-panel/data/pzserver

The panel creates /opt/zomboid-panel/data/pzserver_Data for PZ settings and
save data. Leave Custom config location blank unless you need another location.
Do not use /opt/pzserver unless you also add it and /opt/pzserver_Data to
ReadWritePaths in zomboid-panel.service, then restart the service.

## Linux Troubleshooting
- If you see "Permission denied": chmod +x ZomboidControlPanel start.sh
- If launch fails with glibc errors: requires glibc 2.28+ (CentOS Stream 8+, Rocky 8+, Ubuntu 20.04+).
  CentOS 7 is NOT supported (glibc 2.17 is too old). Use Docker instead.
- The binary is self-contained — Node.js is NOT required.

## CentOS / RHEL Notes
- Open firewall: sudo firewall-cmd --permanent --add-port=3001/tcp && sudo firewall-cmd --reload
- SELinux: If blocked, run: sudo semanage fcontext -a -t admin_home_t "/opt/zomboid-panel(/.*)?" && sudo restorecon -Rv /opt/zomboid-panel
- SteamCMD requires 32-bit libs: sudo yum install glibc.i686 libstdc++.i686
- Increase inotify limit: sudo sysctl -w fs.inotify.max_user_watches=524288
  (make permanent: echo 'fs.inotify.max_user_watches=524288' | sudo tee -a /etc/sysctl.conf)

## Running as a Service (Linux)
A systemd unit file is included:
  sudo useradd -r -m -s /bin/false pzuser      # Create dedicated user (if needed)
  sudo mkdir -p /opt/zomboid-panel
  sudo cp -r ./* /opt/zomboid-panel/
  sudo chown -R pzuser:pzuser /opt/zomboid-panel
  sudo cp zomboid-panel.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now zomboid-panel
Edit the service file to match your install path and user.
See the service file comments for SELinux and firewall setup.

## Docker
The included docker-compose.install.yml starts the panel using the published
Docker image and persistent Docker volumes:

  docker compose -f docker-compose.install.yml up -d

Open http://localhost:3001 after it starts. This installer is for remote PZ
servers or panel-first setup. For a panel that manages a host PZ installation,
download docker-compose.yml from the GitHub repository and configure its bind
mounts before running Docker Compose.

## Folder Structure
- ZomboidControlPanel.exe - Windows standalone binary
- ZomboidControlPanel      - Linux standalone binary
- Start.bat                - Windows launch script
- start.sh                 - Linux launch script
- zomboid-panel.service    - systemd unit file (Linux)
- docker-compose.install.yml - Docker Compose installer (published panel image)
- client/dist/             - Web interface (required, must stay alongside binary)
- data/db.json             - Configuration database (created on first run; NEVER overwrite when upgrading — see data/README.txt)
- data/db.example.json     - Reference db structure (safe to delete)
- data/README.txt          - Upgrade-safety notes for the data/ folder
- logs/                    - Application logs
- pz-mod/                  - PanelBridge server-side Lua (drop into Install/media/lua/server)
- checksums.txt            - SHA256 hashes for release archives
- release-manifest.json    - Build metadata for this package

## Panel Bridge Setup (Optional)
The PanelBridge Lua enables advanced features like weather control. It is a
server-side drop-in, NOT a Workshop mod — there is no client component.
1. Copy pz-mod/PanelBridge/media/lua/server/PanelBridge.lua into your PZ
   dedicated server's install folder: Install/media/lua/server/PanelBridge.lua
2. Restart your PZ server (no .ini changes needed; nothing loads on clients)
3. Go to Settings in the panel and configure the Panel Bridge section

## Notes
- Keep all files in the same folder structure — the binary needs client/dist/.
- The app runs on port 3001 by default.
- First run: go to Settings to configure your PZ server path.

## Upgrading
- The panel auto-update feature handles upgrades safely — prefer it.
- For MANUAL upgrades, do NOT extract the archive over data/. Your db.json
  (admin account + all configs) lives there and the archive must not clobber
  it. Modern releases ship only data/db.example.json inside the archive, so
  a plain extract is safe; back up data/ first if you are unsure. See
  data/README.txt for tar/zip flags.
- If you ever lose db.json, check data/backups/ — the panel keeps the last
  5 auto-snapshots and will restore from the newest on next startup.
`;

  fs.writeFileSync("./release/README.txt", readme);
}

async function main() {
  const args = process.argv.slice(2);
  const targets = resolveTargets(args);

  await cleanDir(distDir);
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  await cleanDir(releaseDir);
  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true });
  }

  console.log("Building client...");
  try {
    execSync("npm run build", { cwd: "./client", stdio: "inherit" });
    console.log("Client built successfully");
  } catch (error) {
    console.error("Client build failed:", error.message);
    process.exit(1);
  }

  console.log("Building server bundle...");

  const rootPkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
  const panelVersion = rootPkg.version || "0.0.0";
  console.log(`Version: ${panelVersion}`);

  // Read PanelBridge.lua and inline it as a base64 define so it lives INSIDE
  // server.cjs (and therefore inside the pkg binary). pkg's `assets` glob was
  // silently skipping the file, leaving the on-disk pz-mod/ folder as the only
  // source — which goes stale after a binary-only auto-update and is the root
  // cause of the "worldmap blank on Linux / mod version mismatch" bug.
  const luaSourcePath = "./pz-mod/PanelBridge/media/lua/server/PanelBridge.lua";
  let panelBridgeLuaB64 = "";
  if (fs.existsSync(luaSourcePath)) {
    panelBridgeLuaB64 = fs.readFileSync(luaSourcePath).toString("base64");
    const luaVerMatch = fs
      .readFileSync(luaSourcePath, "utf8")
      .match(/VERSION\s*=\s*"([^"]+)"/);
    const luaVer = luaVerMatch ? luaVerMatch[1] : "unknown";
    console.log(
      `Embedding PanelBridge.lua v${luaVer} (${panelBridgeLuaB64.length} base64 chars)`,
    );
  } else {
    console.warn(
      `WARNING: ${luaSourcePath} not found — binary will not be able to auto-update the Lua mod.`,
    );
  }

  await esbuild.build({
    entryPoints: ["./server/index.js"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "./dist-exe/server.cjs",
    // ssh2's optional native addons are loaded behind try/catch and have
    // JavaScript fallbacks. Keeping .node files external avoids esbuild trying
    // to bundle architecture-specific binaries for the standalone packages.
    external: ["@aws-sdk/client-s3", "*.node"],
    define: {
      "import.meta.url": "import_meta_url",
      PANEL_VERSION: JSON.stringify(panelVersion),
      PANEL_BRIDGE_LUA_B64: JSON.stringify(panelBridgeLuaB64),
    },
    banner: {
      js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
    },
  });

  console.log("Server bundled successfully");

  const pkgConfig = {
    name: "zomboid-control-panel",
    version: panelVersion,
    bin: "server.cjs",
    pkg: {
      scripts: "server.cjs",
      targets: targets.map((target) => `node22-${target}-x64`),
      outputPath: ".",
    },
  };

  fs.writeFileSync(
    "./dist-exe/package.json",
    JSON.stringify(pkgConfig, null, 2),
  );

  console.log(`Creating executables for: ${targets.join(", ")}`);
  try {
    // @yao-pkg/pkg is the actively maintained fork of vercel/pkg (which is
    // stuck on Node 18.5). Its CLI is also named `pkg`.
    // Build without embedded V8 bytecode cache so binaries remain portable
    // across Linux hosts and don't fail with "V8 rejected the bytecode cache".
    execSync('npx pkg . --compress GZip --public --public-packages "*"', {
      cwd: distDir,
      stdio: "inherit",
    });
  } catch (error) {
    console.error("Failed to create executable(s):", error.message);
    process.exit(1);
  }

  const builtArtifacts = [];
  for (const target of targets) {
    const sourceBinary = resolveBuiltBinaryPath(target);
    const targetBinary =
      target === "linux"
        ? "./release/ZomboidControlPanel"
        : "./release/ZomboidControlPanel.exe";

    if (!sourceBinary) {
      console.error(`Missing build output for target: ${target}`);
      process.exit(1);
    }

    fs.copyFileSync(sourceBinary, targetBinary);
    if (target === "linux") {
      fs.chmodSync(targetBinary, 0o755);
    }

    builtArtifacts.push({
      platform: target,
      fileName: path.basename(targetBinary),
      absolutePath: path.resolve(targetBinary),
    });
  }

  console.log("Creating release package...");

  const clientDist = "./client/dist";
  const targetClientDist = "./release/client/dist";
  if (fs.existsSync(clientDist)) {
    fs.cpSync(clientDist, targetClientDist, { recursive: true });
  } else {
    console.error(
      'Client dist not found. Run "npm run build" in client first.',
    );
    process.exit(1);
  }

  // IMPORTANT: do NOT ship a real `data/db.json` in the release tarball.
  //
  // Users who extract a new release over an existing install (e.g. `tar xzf`
  // or unzipping into the install directory) would have their live database
  // — admin account, server configs, scheduled tasks, all settings —
  // overwritten by an empty stub. We learned this the hard way from issue #5
  // where a user lost everything on a manual upgrade to v1.0.15.
  //
  // The server creates `data/db.json` automatically on first run via LowDB's
  // `defaultData` (see server/database/init.js). We only ship a reference
  // example file and a README warning so users see what shape the file takes
  // without risking their real data.
  fs.mkdirSync("./release/data", { recursive: true });

  const exampleDbSrc = "./data/db.example.json";
  if (fs.existsSync(exampleDbSrc)) {
    fs.copyFileSync(exampleDbSrc, "./release/data/db.example.json");
  } else {
    // Fallback if the example file isn't present in dev — write a minimal one.
    const defaultDb = {
      settings: {
        serverPath: "",
        serverExe: "",
        rconPassword: "",
        rconPort: 27015,
        adminPassword: "",
      },
      players: [],
      scheduledTasks: [],
      servers: [],
      discord: {
        enabled: false,
        token: "",
        guildId: "",
        channelId: "",
        adminRoleId: "",
      },
    };
    fs.writeFileSync(
      "./release/data/db.example.json",
      JSON.stringify(defaultDb, null, 2),
    );
  }

  // Drop a clear upgrade warning next to the example so anyone poking around
  // the data folder during a manual upgrade understands what NOT to overwrite.
  const dataReadme = `data/ — Panel runtime database
=================================

This folder holds the panel's runtime state:

  db.json          Created automatically on first run. Contains your admin
                   account, server configurations, scheduled tasks, mod
                   tracking data, scheduled task history, and all settings.
                   DO NOT delete or overwrite this file — you will lose all
                   your configuration.

  backups/         Auto-rotating snapshots of db.json (every 6h, last 5 kept).
                   The panel will try to restore from the most recent backup
                   if db.json becomes corrupt.

  db.example.json  Reference structure only. Safe to delete.

UPGRADING THE PANEL
-------------------
When upgrading by extracting a release archive over your existing install,
make sure your archive tool does NOT overwrite \`data/db.json\` (or the
\`data/backups/\` folder). Modern releases ship only \`data/db.example.json\`
inside the archive precisely so a plain extract is safe — but if you are
restoring from an older release that contained a real \`db.json\`, exclude
the data/ folder from extraction.

Recommended safe-upgrade commands:

  Linux:   tar xzf release.tar.gz --exclude='data/db.json' --exclude='data/backups'
  Windows: extract everything EXCEPT the data/ folder, or back up data/ first.
`;
  fs.writeFileSync("./release/data/README.txt", dataReadme);

  fs.mkdirSync("./release/logs", { recursive: true });
  fs.writeFileSync("./release/logs/.gitkeep", "");

  if (fs.existsSync("./pz-mod")) {
    fs.cpSync("./pz-mod", "./release/pz-mod", { recursive: true });
  }

  // Ship the browser extension folder. Users can either "Load unpacked"
  // directly from this folder, or zip it themselves.
  if (fs.existsSync("./browser-extension")) {
    fs.cpSync("./browser-extension", "./release/browser-extension", {
      recursive: true,
    });

    // Best-effort standalone zip for the GitHub release asset. Skipped on
    // platforms without PowerShell (Linux build hosts), which is fine —
    // release.ps1 also builds it as part of step 4.
    if (process.platform === "win32") {
      try {
        execSync(
          'powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path browser-extension/* -DestinationPath release/zomboid-panel-extension.zip -Force"',
          { stdio: "inherit" },
        );
      } catch (err) {
        console.warn("Could not build browser-extension zip:", err.message);
      }
    }
  }

  // Ship the sql.js WASM blob next to the executable. vehiclesDb.js loads it
  // at runtime to delete rows from the save's vehicles.db. The file is tiny
  // (~660 KB) and pkg can't introspect sql.js's dynamic require, so we copy
  // it manually.
  const wasmSrc = "./node_modules/sql.js/dist/sql-wasm.wasm";
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, "./release/sql-wasm.wasm");
  } else {
    console.warn(
      "sql-wasm.wasm not found in node_modules/sql.js/dist — vehicle cleanup will fail at runtime. Run `npm install` first.",
    );
  }

  if (fs.existsSync("./zomboid-panel.service")) {
    fs.copyFileSync(
      "./zomboid-panel.service",
      "./release/zomboid-panel.service",
    );
  }

  if (fs.existsSync("./docker-compose.install.yml")) {
    fs.copyFileSync(
      "./docker-compose.install.yml",
      "./release/docker-compose.install.yml",
    );
  }

  // Start.bat v2 — supervisor + applier.
  //
  // Why a supervisor instead of an in-process helper:
  //   The previous design spawned a detached cmd.exe helper from the panel
  //   right before exit, which had to wait for the panel PID to die, rename
  //   the staged exe into place, and respawn. That design was fragile on
  //   Windows for reasons that bit us repeatedly:
  //     - Defender / ASR silently killed the detached helper before it ran.
  //     - `start "" "panel.exe.new"` has no .new file association, hangs or
  //       no-ops depending on shell config.
  //     - TIME_WAIT on port 3001 made the staged exe fail to bind on restart.
  //     - UNC installs (\\host\share) had inconsistent SMB caching of the
  //       helper's writes.
  //   The supervisor sidesteps all of these by performing the rename BETWEEN
  //   panel runs, in a user-visible batch file the user already trusts.
  //
  // Protocol with the panel (Dev1/server/services/panelUpdateChecker.js):
  //   1. Panel reads env var PANEL_SUPERVISOR_V=2 to know the supervisor is
  //      live, and uses the supervisor path instead of spawning a helper.
  //   2. When the user clicks "Apply", the panel writes
  //      ZomboidControlPanel.exe-dir\.update-pending  (a small JSON marker)
  //      and exits with code 75.
  //   3. This .bat sees exit 75 OR sees .update-pending and performs the
  //      apply: back up the running .exe → rename newest .new/.new2 to .exe
  //      → delete the marker → relaunch.
  //   4. All apply events are logged to logs\supervisor.log for diagnostics.
  //
  // Picks the launch target by mtime among .exe / .exe.new / .exe.new2 so a
  // freshly-staged file always wins on the very first launch (before any
  // apply has run), keeping the original one-shot install behavior intact.
  const startBat = `@echo off
setlocal ENABLEDELAYEDEXPANSION
title Zomboid Control Panel
cd /d "%~dp0"

set "PANEL_SUPERVISOR_V=2"
set "INSTALL_DIR=%~dp0"
set "MARKER=%INSTALL_DIR%.update-pending"
set "BASE_EXE=ZomboidControlPanel.exe"
set "LOG_DIR=%INSTALL_DIR%logs"
set "LOG_FILE=%LOG_DIR%\\supervisor.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

call :stamp "Supervisor v2 starting"

echo Starting Zomboid Control Panel...
echo Open your browser to: http://localhost:3001
echo.

:run_loop
  rem === If an update is pending, apply it before launching. ===
  if exist "%MARKER%" call :apply_update

  rem === Pick the binary to launch. Newest of .exe / .exe.new / .exe.new2. ===
  rem === First-install case: only .exe.new exists (from the release zip),  ===
  rem === so this still picks it up on the very first run.                  ===
  set "TARGET="
  for /f "usebackq delims=" %%F in (\`powershell -NoProfile -Command "Get-ChildItem -LiteralPath '.' -File | Where-Object { $_.Name -match '^ZomboidControlPanel\\.exe(\\.new2?)?$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty Name"\`) do set "TARGET=%%F"

  if not defined TARGET (
    call :stamp "ERROR no ZomboidControlPanel binary found"
    echo ERROR: No ZomboidControlPanel binary found in this folder.
    echo Expected one of: ZomboidControlPanel.exe, .exe.new, .exe.new2
    pause
    exit /b 1
  )

  call :stamp "Launching !TARGET!"
  echo Launching !TARGET!
  echo.
  "!TARGET!"
  set "EXITCODE=!ERRORLEVEL!"
  call :stamp "Panel exited with code !EXITCODE!"

  rem Exit code 75 = panel requested restart-for-update.
  if "!EXITCODE!"=="75" (
    echo.
    echo Panel requested restart for update. Applying...
    echo.
    goto run_loop
  )

  rem If a marker appeared during runtime (panel wrote it but then crashed
  rem before exiting with 75), apply on the next loop iteration anyway.
  if exist "%MARKER%" (
    echo.
    echo Update marker present after exit. Applying and relaunching...
    echo.
    goto run_loop
  )

  rem Anything else: stop here and let the user see the exit code.
  echo.
  echo Panel exited with code !EXITCODE!.
  pause
exit /b !EXITCODE!


rem ============================================================
rem :apply_update  — rename staged binary into place.
rem  - Picks newest of .exe.new / .exe.new2 as the source.
rem  - Backs up current .exe to .exe.bak-yyyyMMdd-HHmmss.
rem  - Renames staged → .exe.
rem  - Keeps the 3 most recent .bak-* files, deletes older.
rem ============================================================
:apply_update
  call :stamp "Apply: marker present, beginning swap"

  set "STAGED_NAME="
  for /f "usebackq delims=" %%F in (\`powershell -NoProfile -Command "Get-ChildItem -LiteralPath '.' -File | Where-Object { $_.Name -match '^ZomboidControlPanel\\.exe\\.new2?$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty Name"\`) do set "STAGED_NAME=%%F"

  if not defined STAGED_NAME (
    call :stamp "Apply: no .new/.new2 staged file found; clearing marker"
    del /f /q "%MARKER%" >nul 2>&1
    goto :eof
  )

  if not exist "%BASE_EXE%" goto :do_rename

  rem Build a timestamp suffix for the backup file.
  for /f "usebackq delims=" %%T in (\`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"\`) do set "TS=%%T"
  set "BACKUP=%BASE_EXE%.bak-!TS!"
  call :stamp "Apply: backing up %BASE_EXE% to !BACKUP!"
  ren "%BASE_EXE%" "!BACKUP!" >nul 2>&1
  if errorlevel 1 (
    call :stamp "Apply: ERROR could not back up running .exe ^(still locked?^); aborting swap"
    echo ERROR: could not rename %BASE_EXE% — is the panel still running?
    pause
    goto :eof
  )

:do_rename
  call :stamp "Apply: renaming !STAGED_NAME! to %BASE_EXE%"
  ren "!STAGED_NAME!" "%BASE_EXE%" >nul 2>&1
  if errorlevel 1 (
    call :stamp "Apply: ERROR rename of staged file failed"
    echo ERROR: could not rename !STAGED_NAME! to %BASE_EXE%.
    pause
    goto :eof
  )

  del /f /q "%MARKER%" >nul 2>&1
  call :stamp "Apply: success — update applied"

  rem Prune .bak-* keeping the 3 most recent.
  powershell -NoProfile -Command "Get-ChildItem -LiteralPath '.' -File -Filter 'ZomboidControlPanel.exe.bak-*' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | Remove-Item -Force -ErrorAction SilentlyContinue" >nul 2>&1
goto :eof


:stamp
  rem %~1 = message. Appends a timestamped line to LOG_FILE.
  for /f "usebackq delims=" %%T in (\`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"\`) do set "NOW=%%T"
  >>"%LOG_FILE%" echo [!NOW!] %~1
goto :eof
`;
  fs.writeFileSync("./release/Start.bat", startBat);

  const startSh = `#!/bin/bash
# Zomboid Control Panel — Linux launcher
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting Zomboid Control Panel..."
echo ""
echo "Open your browser to: http://localhost:3001"
echo ""

if [ ! -f "./ZomboidControlPanel" ]; then
  echo "ERROR: ./ZomboidControlPanel was not found in this folder."
  exit 1
fi

# Check glibc version (panel requires glibc 2.28+)
if command -v ldd >/dev/null 2>&1; then
  GLIBC_VER=$(ldd --version 2>&1 | head -1 | grep -oP '\\d+\\.\\d+$' || true)
  if [ -n "$GLIBC_VER" ]; then
    MAJOR=$(echo "$GLIBC_VER" | cut -d. -f1)
    MINOR=$(echo "$GLIBC_VER" | cut -d. -f2)
    if [ "$MAJOR" -lt 2 ] || { [ "$MAJOR" -eq 2 ] && [ "$MINOR" -lt 28 ]; }; then
      echo "WARNING: glibc $GLIBC_VER detected. This binary requires glibc 2.28+."
      echo "CentOS 7 (glibc 2.17) is not supported. Use CentOS Stream 8+, Rocky 8+, or Docker."
    fi
  fi
fi

# Warn if running as root
if [ "$(id -u)" = "0" ]; then
  echo "WARNING: Running as root is not recommended. Consider creating a dedicated user."
fi

./ZomboidControlPanel
`;
  fs.writeFileSync("./release/start.sh", startSh.replace(/\r\n/g, "\n"), {
    mode: 0o755,
  });

  const checksumLines = [];
  const manifestArtifacts = [];
  for (const artifact of builtArtifacts) {
    const checksum = sha256File(artifact.absolutePath);
    checksumLines.push(`${checksum}  ${artifact.fileName}`);
    manifestArtifacts.push({
      platform: artifact.platform,
      file: artifact.fileName,
      sha256: checksum,
    });
  }

  fs.writeFileSync("./release/checksums.txt", `${checksumLines.join("\n")}\n`);
  fs.writeFileSync(
    "./release/release-manifest.json",
    JSON.stringify(
      {
        version: panelVersion,
        builtAt: new Date().toISOString(),
        hostPlatform: process.platform,
        targets,
        artifacts: manifestArtifacts,
      },
      null,
      2,
    ),
  );

  writeReleaseReadme();

  console.log("Release package created successfully");
  console.log("Location: ./release/");
  console.log("Contents:");
  for (const artifact of builtArtifacts) {
    console.log(`  - ${artifact.fileName} (${artifact.platform})`);
  }
  console.log("  - Start.bat");
  console.log("  - start.sh");
  console.log("  - checksums.txt");
  console.log("  - release-manifest.json");
  console.log("  - client/dist/");
  console.log("  - data/");
  console.log("  - logs/");
  console.log("  - pz-mod/");
  if (fs.existsSync("./release/zomboid-panel.service")) {
    console.log("  - zomboid-panel.service");
  }
  if (fs.existsSync("./release/docker-compose.install.yml")) {
    console.log("  - docker-compose.install.yml");
  }
  console.log("  - README.txt");
}

await main();
