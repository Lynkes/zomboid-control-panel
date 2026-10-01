import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildLinuxLdLibraryCandidates,
  detectLeftoverNativeLibraries,
  describeLeftoverNativeLibraries,
  formatJavaLibraryPath,
  formatShellLibraryDirs,
  isPzNativeLibraryName,
  normalizeLibraryDirEntry,
  parseLibraryPathFromLaunchConfig,
  resolveGameDirForNativeCheck,
  resolveNativeLibraryDirs,
} from "../utils/nativeLibraryPaths.js";

// 2026-10-01 incident (Unraid all-in-one, Build 42.21): a leftover natives/
// folder (libPZPopMan64.so 5.9 MB from 2026-07-22, no
// n_updateRealZombies symbol) sat next to the current linux64/ one (9.0 MB,
// 2026-09-29), and the generated start-server_<name>.sh put natives/ first
// -- every world save died with UnsatisfiedLinkError. These pin where the
// library folders come from now, and what the leftover check reports.

// The Linux 42.21 dedicated server's ProjectZomboid64.json, trimmed to what
// matters here.
const LINUX_42_21_CONFIG = {
  mainClass: "zombie/network/GameServer",
  classpath: ["java/.", "java/projectzomboid.jar"],
  vmArgs: [
    "-Djava.awt.headless=true",
    "-Xmx8g",
    "-Dzomboid.steam=1",
    "-Djava.library.path=linux64/",
    "-XX:+UseZGC",
  ],
};

// The shape of the Windows ProjectZomboid64.json as shipped (top-level
// vmArgs plus per-OS-version blocks nested under "windows").
const WINDOWS_CONFIG = {
  mainClass: "zombie/gameStates/MainScreenState",
  classpath: [".", "projectzomboid.jar"],
  vmArgs: [
    "-Djava.awt.headless=true",
    "--enable-native-access=ALL-UNNAMED",
    "-Djava.library.path=win64/;.",
    "-XX:-OmitStackTraceInFastThrow",
  ],
  windows: {
    "6.1": { vmArgs: ["-XX:+UseG1GC"] },
    "10.0.17134": { vmArgs: ["-XX:+UseZGC"] },
  },
};

let roots = [];

function makeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-libs-"));
  roots.push(root);
  return root;
}

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeConfig(root, config) {
  writeFile(
    root,
    "ProjectZomboid64.json",
    typeof config === "string" ? config : JSON.stringify(config, null, "\t"),
  );
}

// The incident's layout: current libraries in linux64/, older (smaller,
// different) copies of some of them in natives/.
function makeIncidentInstall({ withConfig = true } = {}) {
  const root = makeInstall();
  writeFile(root, "linux64/libPZPopMan64.so", Buffer.alloc(900, 2));
  writeFile(root, "linux64/libPZPathFind64.so", Buffer.alloc(700, 3));
  writeFile(root, "linux64/libsteam_api.so", Buffer.alloc(50, 1));
  writeFile(root, "natives/libPZPopMan64.so", Buffer.alloc(590, 9));
  writeFile(root, "natives/libPZPathFind64.so", Buffer.alloc(700, 3));
  if (withConfig) writeConfig(root, LINUX_42_21_CONFIG);
  return root;
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("isPzNativeLibraryName()", () => {
  it("recognizes the game's own libraries, not Steam's or the JRE's", () => {
    for (const name of [
      "libPZPopMan64.so",
      "libPZPathFind64.so",
      "libPZBullet64.so",
      "libRakNet64.so",
      "libZNetJNI64.so",
      "libLighting64.so",
    ]) {
      expect(isPzNativeLibraryName(name, "linux")).toBe(true);
    }
    for (const name of ["libsteam_api.so", "libjava.so", "libPZPopMan64.so.bak", "PZPopMan64.dll"]) {
      expect(isPzNativeLibraryName(name, "linux")).toBe(false);
    }
    expect(isPzNativeLibraryName("PZPopMan64.dll", "win32")).toBe(true);
    expect(isPzNativeLibraryName("steam_api64.dll", "win32")).toBe(false);
  });
});

describe("normalizeLibraryDirEntry()", () => {
  it("normalizes relative folders and the install root", () => {
    expect(normalizeLibraryDirEntry("linux64/")).toBe("linux64");
    expect(normalizeLibraryDirEntry("./natives/win64/")).toBe("natives/win64");
    expect(normalizeLibraryDirEntry("natives\\win64\\")).toBe("natives/win64");
    expect(normalizeLibraryDirEntry(".")).toBe(".");
    expect(normalizeLibraryDirEntry("./")).toBe(".");
  });

  it("rejects anything absolute, escaping the install, or unsafe in a script", () => {
    for (const entry of [
      "/usr/lib",
      "/tmp/evil",
      "C:\\Windows\\System32",
      "\\\\server\\share",
      "../linux64",
      "linux64/../..",
      "natives/./x",
      "$(touch pwned)",
      "lib dir",
      "a\"b",
      "`id`",
    ]) {
      expect(normalizeLibraryDirEntry(entry), entry).toBeNull();
    }
  });
});

describe("parseLibraryPathFromLaunchConfig()", () => {
  it("reads the Linux 42.21 file's -Djava.library.path=linux64/", () => {
    expect(parseLibraryPathFromLaunchConfig(JSON.stringify(LINUX_42_21_CONFIG))).toEqual({
      ok: true,
      dirs: ["linux64"],
    });
  });

  it("reads the Windows file's top-level vmArgs and ignores the nested per-OS blocks", () => {
    expect(parseLibraryPathFromLaunchConfig(JSON.stringify(WINDOWS_CONFIG))).toEqual({
      ok: true,
      dirs: ["win64", "."],
    });
  });

  it("takes the last -Djava.library.path, as java does", () => {
    const config = { vmArgs: ["-Djava.library.path=natives/", "-Djava.library.path=linux64/:natives/"] };
    expect(parseLibraryPathFromLaunchConfig(JSON.stringify(config))).toEqual({
      ok: true,
      dirs: ["linux64", "natives"],
    });
  });

  it("rejects the whole value when any entry is absolute or escapes the install", () => {
    for (const libraryPath of [
      "linux64/:/usr/lib/evil",
      "../../../tmp/evil:linux64/",
      "C:\\evil;natives/",
      "linux64/:$(reboot)",
    ]) {
      const result = parseLibraryPathFromLaunchConfig(
        JSON.stringify({ vmArgs: [`-Djava.library.path=${libraryPath}`] }),
      );
      expect(result.ok, libraryPath).toBe(false);
      expect(result.reason).toMatch(/outside the install/);
    }
  });

  it("rejects malformed files without throwing", () => {
    expect(parseLibraryPathFromLaunchConfig("{not json").ok).toBe(false);
    expect(parseLibraryPathFromLaunchConfig("null").ok).toBe(false);
    expect(parseLibraryPathFromLaunchConfig(JSON.stringify({ vmArgs: "nope" })).ok).toBe(false);
    expect(parseLibraryPathFromLaunchConfig(JSON.stringify({ vmArgs: ["-Xmx8g"] })).ok).toBe(false);
    expect(
      parseLibraryPathFromLaunchConfig(JSON.stringify({ vmArgs: ["-Djava.library.path="] })).ok,
    ).toBe(false);
    const tooMany = Array.from({ length: 12 }, (_, i) => `d${i}`).join(":");
    expect(
      parseLibraryPathFromLaunchConfig(
        JSON.stringify({ vmArgs: [`-Djava.library.path=${tooMany}`] }),
      ).ok,
    ).toBe(false);
  });
});

describe("resolveNativeLibraryDirs()", () => {
  it("uses the install's own ProjectZomboid64.json when it is present and sane (the incident layout)", () => {
    const root = makeIncidentInstall();
    expect(resolveNativeLibraryDirs(root, { platform: "linux" })).toEqual({
      dirs: ["linux64", "."],
      source: "launchConfig",
      rejectedReason: null,
    });
  });

  it("without the file, puts linux64/ first and leaves a stale natives/ off entirely", () => {
    const root = makeIncidentInstall({ withConfig: false });
    expect(resolveNativeLibraryDirs(root, { platform: "linux" })).toEqual({
      dirs: ["linux64", "."],
      source: "linux64",
      rejectedReason: null,
    });
  });

  it("falls back to natives/ (after linux64/) only when linux64/ holds no game library", () => {
    const root = makeInstall();
    writeFile(root, "linux64/libsteam_api.so", "steam");
    writeFile(root, "natives/libPZPopMan64.so", "old layout");
    expect(resolveNativeLibraryDirs(root, { platform: "linux" })).toEqual({
      dirs: ["linux64", "natives", "natives/linux64", "."],
      source: "fallback",
      rejectedReason: null,
    });
  });

  it("falls back the same way for a missing install folder", () => {
    const missing = path.join(os.tmpdir(), "zcp-native-libs-does-not-exist");
    expect(resolveNativeLibraryDirs(missing, { platform: "linux" }).dirs).toEqual([
      "linux64",
      "natives",
      "natives/linux64",
      ".",
    ]);
  });

  it("ignores a malicious file and says why", () => {
    const root = makeIncidentInstall({ withConfig: false });
    writeConfig(root, { vmArgs: ["-Djava.library.path=/tmp/evil:../../etc:linux64/"] });
    const result = resolveNativeLibraryDirs(root, { platform: "linux" });
    expect(result.dirs).toEqual(["linux64", "."]);
    expect(result.source).toBe("linux64");
    expect(result.rejectedReason).toMatch(/outside the install/);
  });

  it("ignores a corrupt file and says why", () => {
    const root = makeIncidentInstall({ withConfig: false });
    writeConfig(root, "{ truncated");
    const result = resolveNativeLibraryDirs(root, { platform: "linux" });
    expect(result.source).toBe("linux64");
    expect(result.rejectedReason).toMatch(/not valid JSON/);
  });

  it("ignores a file whose folders hold no game library", () => {
    const root = makeIncidentInstall({ withConfig: false });
    fs.mkdirSync(path.join(root, "win64"));
    writeConfig(root, { vmArgs: ["-Djava.library.path=win64/"] });
    const result = resolveNativeLibraryDirs(root, { platform: "linux" });
    expect(result.dirs).toEqual(["linux64", "."]);
    expect(result.rejectedReason).toMatch(/no game library/);
  });

  it("follows the game's own file even when it lists natives/ (an older build that really uses it)", () => {
    const root = makeIncidentInstall({ withConfig: false });
    writeConfig(root, { vmArgs: ["-Djava.library.path=linux64/:natives/"] });
    expect(resolveNativeLibraryDirs(root, { platform: "linux" }).dirs).toEqual([
      "linux64",
      "natives",
      ".",
    ]);
  });

  it("Windows: keeps natives/;natives/win64/;. without a usable file", () => {
    const root = makeInstall();
    writeFile(root, "PZPopMan64.dll", "dll");
    expect(resolveNativeLibraryDirs(root, { platform: "win32" })).toEqual({
      dirs: ["natives", "natives/win64", "."],
      source: "windows",
      rejectedReason: null,
    });
  });

  it("Windows: follows the shipped ProjectZomboid64.json shape, DLLs in the install root", () => {
    const root = makeInstall();
    writeFile(root, "PZPopMan64.dll", "dll");
    writeConfig(root, WINDOWS_CONFIG);
    const result = resolveNativeLibraryDirs(root, { platform: "win32" });
    expect(result).toEqual({ dirs: ["win64", "."], source: "launchConfig", rejectedReason: null });
    expect(formatJavaLibraryPath(result.dirs, "win32")).toBe("win64/;.");
  });
});

describe("formatting", () => {
  it("formats -Djava.library.path for each platform", () => {
    expect(formatJavaLibraryPath(["linux64", "."], "linux")).toBe("linux64/:.");
    expect(formatJavaLibraryPath(["natives", "natives/win64", "."], "win32")).toBe(
      "natives/;natives/win64/;.",
    );
  });

  it("formats the script's LD_LIBRARY_PATH folders relative to ${INSTDIR}", () => {
    expect(formatShellLibraryDirs(["linux64", "natives", "."])).toEqual([
      "${INSTDIR}/linux64/",
      "${INSTDIR}/natives/",
    ]);
  });
});

describe("buildLinuxLdLibraryCandidates() (serverManager.buildLdLibraryPath)", () => {
  it("lists linux64/ and leaves the stale natives/ out when linux64/ has the libraries", () => {
    const root = makeIncidentInstall();
    const candidates = buildLinuxLdLibraryCandidates(root);
    expect(candidates[0]).toBe(path.join(root, "linux64"));
    expect(candidates).not.toContain(path.join(root, "natives"));
    expect(candidates).toContain(root);
    expect(candidates.indexOf(path.join(root, "linux64"))).toBeLessThan(candidates.indexOf(root));
  });

  it("keeps linux64/ ahead of natives/ in the fallback", () => {
    const root = makeInstall();
    writeFile(root, "natives/libPZPopMan64.so", "old layout");
    const candidates = buildLinuxLdLibraryCandidates(root);
    expect(candidates.indexOf(path.join(root, "linux64"))).toBeLessThan(
      candidates.indexOf(path.join(root, "natives")),
    );
  });
});

describe("detectLeftoverNativeLibraries()", () => {
  it("reports the incident: natives/ holds a different libPZPopMan64.so than linux64/", async () => {
    const root = makeIncidentInstall();
    const leftover = await detectLeftoverNativeLibraries(root, { platform: "linux" });
    expect(leftover).not.toBeNull();
    expect(leftover.folder).toBe("natives/");
    expect(leftover.libraries).toEqual(["libPZPopMan64.so"]);
    expect(leftover.differing).toEqual([
      expect.objectContaining({
        name: "libPZPopMan64.so",
        folder: "natives/",
        reason: "size",
        leftoverSize: 590,
        currentSize: 900,
      }),
    ]);
    // Read-only: nothing renamed or deleted.
    expect(fs.existsSync(path.join(root, "natives", "libPZPopMan64.so"))).toBe(true);
  });

  it("catches a same-size copy with different content", async () => {
    const root = makeIncidentInstall();
    writeFile(root, "natives/libPZPathFind64.so", Buffer.alloc(700, 4));
    const leftover = await detectLeftoverNativeLibraries(root, { platform: "linux" });
    expect(leftover.differing).toContainEqual(
      expect.objectContaining({ name: "libPZPathFind64.so", reason: "content" }),
    );
  });

  it("reports a library the current build no longer ships, and natives/linux64/ too", async () => {
    const root = makeIncidentInstall();
    writeFile(root, "natives/linux64/libZNetJNI64.so", "old");
    const leftover = await detectLeftoverNativeLibraries(root, { platform: "linux" });
    expect(leftover.differing).toContainEqual(
      expect.objectContaining({
        name: "libZNetJNI64.so",
        folder: "natives/linux64/",
        reason: "missingFromCurrent",
        currentSize: null,
      }),
    );
  });

  it("says nothing when natives/ is a byte-identical copy", async () => {
    const root = makeInstall();
    writeFile(root, "linux64/libPZPopMan64.so", Buffer.alloc(900, 2));
    writeFile(root, "natives/libPZPopMan64.so", Buffer.alloc(900, 2));
    expect(await detectLeftoverNativeLibraries(root, { platform: "linux" })).toBeNull();
  });

  it("says nothing when linux64/ holds no game library (natives/ is the real one then)", async () => {
    const root = makeInstall();
    writeFile(root, "natives/libPZPopMan64.so", "old layout");
    expect(await detectLeftoverNativeLibraries(root, { platform: "linux" })).toBeNull();
  });

  it("says nothing when the game's own ProjectZomboid64.json lists natives/", async () => {
    const root = makeIncidentInstall({ withConfig: false });
    writeConfig(root, { vmArgs: ["-Djava.library.path=linux64/:natives/"] });
    expect(await detectLeftoverNativeLibraries(root, { platform: "linux" })).toBeNull();
  });

  it("says nothing on Windows or without a path", async () => {
    const root = makeIncidentInstall();
    expect(await detectLeftoverNativeLibraries(root, { platform: "win32" })).toBeNull();
    expect(await detectLeftoverNativeLibraries(null, { platform: "linux" })).toBeNull();
  });

  it("describes the finding for the panel log: what, why it matters, and that removing it is safe", async () => {
    const root = makeIncidentInstall();
    const leftover = await detectLeftoverNativeLibraries(root, { platform: "linux" });
    const message = describeLeftoverNativeLibraries(root, leftover);
    expect(message).toContain(path.join(root, "natives"));
    expect(message).toContain("libPZPopMan64.so");
    expect(message).toContain("UnsatisfiedLinkError");
    expect(message).toMatch(/safe to remove or rename the natives\/ folder/);
    expect(message).toMatch(/never deletes it/);
  });
});

describe("resolveGameDirForNativeCheck()", () => {
  it("uses the launch folder, or the folder a custom launcher sits in", () => {
    expect(resolveGameDirForNativeCheck({ installPath: "/pz-server" })).toBe("/pz-server");
    expect(
      resolveGameDirForNativeCheck({ installPath: "/pz-server", serverPath: "/pz-server/run.sh" }),
    ).toBe("/pz-server");
    expect(resolveGameDirForNativeCheck({ serverPath: "/opt/pz/custom.sh" })).toBe(
      path.dirname("/opt/pz/custom.sh"),
    );
    expect(resolveGameDirForNativeCheck({})).toBeNull();
    expect(resolveGameDirForNativeCheck(null)).toBeNull();
  });
});
