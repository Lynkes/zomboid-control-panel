import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

// The leftover-natives warning is a panel-log line, so the log is the
// observable here.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../utils/logger.js", () => ({
  createLogger: () => logSpy,
}));

const {
  generateStartupScripts,
  refreshLaunchTargetBeforeStart,
  writeStartupScriptsWithBackup,
} = await import("../routes/server.js");

// 2026-10-01 incident (Unraid all-in-one, Build 42.21): the generated
// start-server_<name>.sh exported
//   LD_LIBRARY_PATH="${INSTDIR}/natives/:${INSTDIR}/natives/linux64/:${INSTDIR}/linux64/:..."
// and ran java with -Djava.library.path=natives/:natives/linux64/:linux64/:.
// so a leftover natives/ folder from an older build shadowed linux64/, and
// every world save died with UnsatisfiedLinkError on
// ZombiePopulationManager.n_updateRealZombies.
const OLD_LD_LINE =
  'export LD_LIBRARY_PATH="${INSTDIR}/natives/:${INSTDIR}/natives/linux64/:${INSTDIR}/linux64/:${INSTDIR}:${INSTDIR}/jre64/lib/amd64:${INSTDIR}/jre64/lib/x86_64:/usr/lib64:${LD_LIBRARY_PATH}"';
const OLD_JAVA_LIBRARY_PATH = "-Djava.library.path=natives/:natives/linux64/:linux64/:.";

let roots = [];

function makeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-order-"));
  roots.push(root);
  return root;
}

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeIncidentInstall({ withConfig = true } = {}) {
  const root = makeInstall();
  writeFile(root, "linux64/libPZPopMan64.so", Buffer.alloc(900, 2));
  writeFile(root, "natives/libPZPopMan64.so", Buffer.alloc(590, 9));
  if (withConfig) {
    writeFile(
      root,
      "ProjectZomboid64.json",
      JSON.stringify({ vmArgs: ["-Xmx8g", "-Djava.library.path=linux64/"] }),
    );
  }
  return root;
}

function scriptOptions(installPath) {
  return { installPath, serverName: "Tower", minMemory: 4, maxMemory: 8 };
}

function ldLine(sh) {
  return sh.split("\n").find((line) => line.startsWith("export LD_LIBRARY_PATH="));
}

function javaLibraryPath(script) {
  return script.match(/-Djava\.library\.path=(\S+)/)[1];
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  getActiveServer.mockReset();
  for (const fn of Object.values(logSpy)) fn.mockClear();
});

describe("generateStartupScripts(): native library order", () => {
  it("the incident layout: loads only linux64/, exactly as the game's own files say", () => {
    const { sh } = generateStartupScripts(scriptOptions(makeIncidentInstall()));
    expect(ldLine(sh)).toBe(
      'export LD_LIBRARY_PATH="${INSTDIR}/linux64/:${INSTDIR}:${INSTDIR}/jre64/lib/amd64:${INSTDIR}/jre64/lib/x86_64:/usr/lib64:${LD_LIBRARY_PATH}"',
    );
    expect(javaLibraryPath(sh)).toBe("linux64/:.");
    expect(sh).not.toContain("natives");
  });

  it("without ProjectZomboid64.json, linux64/ still wins and the stale natives/ stays off the path", () => {
    const { sh } = generateStartupScripts(scriptOptions(makeIncidentInstall({ withConfig: false })));
    expect(javaLibraryPath(sh)).toBe("linux64/:.");
    expect(ldLine(sh)).toMatch(/^export LD_LIBRARY_PATH="\$\{INSTDIR\}\/linux64\/:\$\{INSTDIR\}:/);
    expect(sh).not.toContain("natives");
  });

  it("linux64/ precedes natives/ on both paths whenever natives/ is on them at all", () => {
    // linux64/ without game libraries: natives/ is the fallback, behind it.
    const root = makeInstall();
    writeFile(root, "natives/libPZPopMan64.so", "older layout");
    const { sh } = generateStartupScripts(scriptOptions(root));
    const libraryPath = javaLibraryPath(sh);
    expect(libraryPath).toBe("linux64/:natives/:natives/linux64/:.");
    const ld = ldLine(sh);
    expect(ld.indexOf("${INSTDIR}/linux64/")).toBeGreaterThan(-1);
    expect(ld.indexOf("${INSTDIR}/linux64/")).toBeLessThan(ld.indexOf("${INSTDIR}/natives/"));
    // Same for an install folder that doesn't exist yet (scripts written
    // before SteamCMD finished).
    const { sh: early } = generateStartupScripts(
      scriptOptions(path.join(os.tmpdir(), "zcp-native-order-missing")),
    );
    expect(javaLibraryPath(early).indexOf("linux64/")).toBe(0);
  });

  it("never writes a malicious ProjectZomboid64.json entry into the script", () => {
    const root = makeIncidentInstall({ withConfig: false });
    writeFile(
      root,
      "ProjectZomboid64.json",
      JSON.stringify({ vmArgs: ['-Djava.library.path=linux64/:/tmp/x";touch /tmp/pwned;"'] }),
    );
    const { sh, bat } = generateStartupScripts(scriptOptions(root));
    expect(sh).not.toContain("pwned");
    expect(bat).not.toContain("pwned");
    expect(javaLibraryPath(sh)).toBe("linux64/:.");
  });

  it("Windows .bat keeps natives/;natives/win64/;. when the install has no usable ProjectZomboid64.json", () => {
    const { bat } = generateStartupScripts(scriptOptions(makeIncidentInstall({ withConfig: false })));
    expect(javaLibraryPath(bat)).toBe("natives/;natives/win64/;.");
  });

  it("Windows .bat follows the shipped ProjectZomboid64.json when its folders hold the DLLs", () => {
    const root = makeInstall();
    writeFile(root, "PZPopMan64.dll", "dll");
    writeFile(
      root,
      "ProjectZomboid64.json",
      JSON.stringify({
        vmArgs: ["-Djava.library.path=win64/;."],
        windows: { "10.0.17134": { vmArgs: ["-XX:+UseZGC"] } },
      }),
    );
    const { bat } = generateStartupScripts(scriptOptions(root));
    expect(javaLibraryPath(bat)).toBe("win64/;.");
  });
});

describe("refreshLaunchTargetBeforeStart(): existing installs get the fix on their next start", () => {
  function serverFor(installPath) {
    return {
      installPath,
      serverName: "Tower",
      minMemory: 4,
      maxMemory: 8,
      serverPort: 16261,
    };
  }

  it("rewrites a v1.4.1 natives-first script before the launch, with no backup prompt", async () => {
    const root = makeIncidentInstall();
    const server = serverFor(root);
    getActiveServer.mockResolvedValue(server);

    // What the panel wrote before this fix, recorded as its own output (the
    // fingerprint sidecar), the way every existing install has it.
    const current = generateStartupScripts(scriptOptions(root));
    const oldSh = current.sh
      .replace(ldLine(current.sh), OLD_LD_LINE)
      .replace(/-Djava\.library\.path=\S+/, OLD_JAVA_LIBRARY_PATH);
    const shPath = path.join(root, "start-server_Tower.sh");
    writeStartupScriptsWithBackup(root, [{ path: shPath, content: oldSh }]);
    expect(fs.readFileSync(shPath, "utf8")).toContain(OLD_JAVA_LIBRARY_PATH);

    const result = await refreshLaunchTargetBeforeStart(server, { platform: "linux" });

    const rewritten = fs.readFileSync(shPath, "utf8");
    expect(javaLibraryPath(rewritten)).toBe("linux64/:.");
    expect(rewritten).not.toContain("natives");
    expect(result.scriptBackupWarnings).toEqual([]);
    expect(fs.readdirSync(root).some((name) => name.includes(".bak-"))).toBe(false);
  });

  it("logs the leftover natives/ folder at launch, and leaves it in place", async () => {
    const root = makeIncidentInstall();
    const server = serverFor(root);
    getActiveServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server, { platform: "linux" });

    const warnings = logSpy.warn.mock.calls.map(([message]) => String(message));
    const leftoverWarning = warnings.find((message) => message.includes("Leftover native libraries"));
    expect(leftoverWarning).toBeDefined();
    expect(leftoverWarning).toContain("libPZPopMan64.so");
    expect(leftoverWarning).toMatch(/safe to remove or rename the natives\/ folder/);
    expect(fs.existsSync(path.join(root, "natives", "libPZPopMan64.so"))).toBe(true);
  });

  it("logs it for a custom launcher too -- the case the panel's own script can't fix", async () => {
    const root = makeIncidentInstall();
    writeFile(root, "my-launcher.sh", "#!/bin/bash\n");
    const server = { ...serverFor(root), serverPath: path.join(root, "my-launcher.sh") };
    getActiveServer.mockResolvedValue(server);

    await refreshLaunchTargetBeforeStart(server, { platform: "linux" });

    expect(
      logSpy.warn.mock.calls.some(([message]) => String(message).includes("Leftover native libraries")),
    ).toBe(true);
  });

  it("stays quiet for a clean install, a container-managed server and Windows", async () => {
    const clean = makeInstall();
    writeFile(clean, "linux64/libPZPopMan64.so", "current");
    getActiveServer.mockResolvedValue(serverFor(clean));
    await refreshLaunchTargetBeforeStart(serverFor(clean), { platform: "linux" });

    const incident = makeIncidentInstall();
    await refreshLaunchTargetBeforeStart(serverFor(incident), {
      platform: "linux",
      managedHandled: true,
    });
    await refreshLaunchTargetBeforeStart(serverFor(incident), { platform: "win32" });

    expect(
      logSpy.warn.mock.calls.some(([message]) => String(message).includes("Leftover native libraries")),
    ).toBe(false);
  });
});
