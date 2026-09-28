import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkBridgeVersion,
  getBridgeVersionStatus,
  nextBridgeVersion,
  runCheckBridgeVersionCli,
  validateReleaseVersion,
  writeBridgeVersionLock,
} from "../../scripts/check-bridge-version.mjs";
import { BRIDGE_FILES, REPO_ROOT, computeCodeSha256, readLock } from "../../scripts/workshop/lib.mjs";

// scripts/check-bridge-version.mjs decides when the PanelBridge VERSION moves
// (spec §8.6): only when the normalized Lua/mod.info bytes differ from
// pz-mod/bridge-version.lock.json. Every published bridge update makes each
// Steam Workshop server refuse new joins until it restarts, so both a no-op
// bump and changed code shipped under the old number are release bugs.

const SCRIPT = path.join(REPO_ROOT, "scripts", "check-bridge-version.mjs");
const tempDirs = [];

function luaSource(version, body = "return PanelBridge") {
  return [
    "---@diagnostic disable: undefined-global",
    "--[[",
    "    PanelBridge - Server-side mod for Zomboid Control Panel",
    `    Version: ${version}`,
    "",
    `                v${version} Changes:`,
    "                - Fix: something.",
    "]]",
    "",
    "if not (isServer and isServer()) then return end",
    "",
    "local PanelBridge = {",
    `    VERSION = "${version}",`,
    "    PROTOCOL_VERSION = \"queue-v1\",",
    "    MOD_ID = \"ZomboidControlPanelBridge\",",
    "}",
    body,
    "",
  ].join("\n");
}

function modInfo(version) {
  return `name=Zomboid Control Panel Bridge\nid=ZomboidControlPanelBridge\nmodversion=${version}\n`;
}

function makeTree({ version = "1.2.3", lockVersion = version, body, lock = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-version-"));
  tempDirs.push(root);
  const write = (relativePath, content) => {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  };
  write(BRIDGE_FILES.serverLua, luaSource(lockVersion, body));
  write(BRIDGE_FILES.clientLua, "if not (isClient and isClient()) then return end\n");
  write(BRIDGE_FILES.modInfo, modInfo(lockVersion));
  if (lock) writeBridgeVersionLock(root, lockVersion);
  return {
    root,
    write,
    setVersion(next) {
      write(BRIDGE_FILES.serverLua, luaSource(next, body));
      write(BRIDGE_FILES.modInfo, modInfo(next));
    },
    changeCode(next = version) {
      write(BRIDGE_FILES.serverLua, luaSource(next, `${body ?? "return PanelBridge"}\n-- changed`));
      write(BRIDGE_FILES.modInfo, modInfo(next));
    },
  };
}

function runCli(args) {
  const lines = { out: [], err: [] };
  const code = runCheckBridgeVersionCli(args, {
    log: (line) => lines.out.push(String(line)),
    error: (line) => lines.err.push(String(line)),
  });
  return { code, out: lines.out.join("\n"), err: lines.err.join("\n") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-bridge-version: the code hash", () => {
  it("hashes CRLF+BOM and LF checkouts identically", () => {
    const tree = makeTree();
    const lf = computeCodeSha256(tree.root);
    for (const file of [BRIDGE_FILES.serverLua, BRIDGE_FILES.clientLua, BRIDGE_FILES.modInfo]) {
      const full = path.join(tree.root, file);
      fs.writeFileSync(full, `\uFEFF${fs.readFileSync(full, "utf8").replace(/\n/g, "\r\n")}`);
    }
    expect(computeCodeSha256(tree.root)).toBe(lf);
  });

  it("ignores the three version declarations but not the code around them", () => {
    const tree = makeTree();
    const before = computeCodeSha256(tree.root);
    tree.setVersion("9.9.9");
    // The "v9.9.9 Changes:" header line also moved, so this is a code change.
    expect(computeCodeSha256(tree.root)).not.toBe(before);

    const lua = path.join(tree.root, BRIDGE_FILES.serverLua);
    tree.setVersion("1.2.3");
    fs.writeFileSync(lua, fs.readFileSync(lua, "utf8").replace("Version: 1.2.3", "Version: 4.5.6").replace("VERSION = \"1.2.3\"", "VERSION = \"4.5.6\""));
    fs.writeFileSync(path.join(tree.root, BRIDGE_FILES.modInfo), modInfo("4.5.6"));
    expect(computeCodeSha256(tree.root)).toBe(before);
  });

  it("changes when any of the three files changes", () => {
    const tree = makeTree();
    const before = computeCodeSha256(tree.root);
    tree.write(BRIDGE_FILES.clientLua, "if not (isClient and isClient()) then return end\n-- edit\n");
    expect(computeCodeSha256(tree.root)).not.toBe(before);
  });
});

describe("check-bridge-version: PR and release modes", () => {
  it("passes an unchanged tree with no notice in both modes", () => {
    const tree = makeTree();
    const status = getBridgeVersionStatus(tree.root);
    expect(status).toMatchObject({ version: "1.2.3", lockVersion: "1.2.3", changed: false });
    expect(checkBridgeVersion(status)).toEqual({ errors: [], notices: [] });
    expect(checkBridgeVersion(status, { release: true })).toEqual({ errors: [], notices: [] });
  });

  it("fails a no-op bump: the version moved but the code didn't", () => {
    const tree = makeTree();
    const lua = path.join(tree.root, BRIDGE_FILES.serverLua);
    fs.writeFileSync(lua, fs.readFileSync(lua, "utf8").replace("Version: 1.2.3", "Version: 1.2.4").replace("VERSION = \"1.2.3\"", "VERSION = \"1.2.4\""));
    fs.writeFileSync(path.join(tree.root, BRIDGE_FILES.modInfo), modInfo("1.2.4"));
    const { errors } = checkBridgeVersion(getBridgeVersionStatus(tree.root));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/1\.2\.4 but its code is unchanged since 1\.2\.3/);
  });

  it("passes changed code under the locked version in PR mode, with a notice, and fails it in release mode", () => {
    const tree = makeTree();
    tree.changeCode("1.2.3");
    const status = getBridgeVersionStatus(tree.root);
    expect(status.changed).toBe(true);
    expect(checkBridgeVersion(status)).toEqual({
      errors: [],
      notices: ["unreleased PanelBridge changes; the next release bumps the version"],
    });
    const [releaseError] = checkBridgeVersion(status, { release: true }).errors;
    expect(releaseError).toMatch(/differs from pz-mod\/bridge-version\.lock\.json \(1\.2\.3\)/);
    // Points at the release script, not at re-locking the old number by hand.
    expect(releaseError).toMatch(/Cut releases with release\.ps1: it moves PanelBridge to 1\.2\.4 and rewrites the lock\./);
    expect(releaseError).not.toMatch(/--write-lock/);
  });

  it("fails a version below the lock whether or not the code changed", () => {
    const tree = makeTree({ version: "1.2.3" });
    tree.changeCode("1.2.2");
    expect(checkBridgeVersion(getBridgeVersionStatus(tree.root)).errors[0]).toMatch(/1\.2\.2 is below the released 1\.2\.3/);
  });

  it("fails when the header, VERSION and modversion disagree", () => {
    const tree = makeTree();
    tree.write(BRIDGE_FILES.modInfo, modInfo("1.2.4"));
    expect(checkBridgeVersion(getBridgeVersionStatus(tree.root)).errors.join("\n")).toMatch(/versions differ/);
  });

  it("fails when the lock file is missing", () => {
    const tree = makeTree({ lock: false });
    expect(checkBridgeVersion(getBridgeVersionStatus(tree.root)).errors[0]).toMatch(/bridge-version\.lock\.json is missing/);
  });
});

describe("check-bridge-version: --next, --validate and --write-lock", () => {
  it("keeps the lock version while the code is unchanged", () => {
    expect(nextBridgeVersion(getBridgeVersionStatus(makeTree().root))).toBe("1.2.3");
  });

  it("undoes a no-op bump rather than shipping it", () => {
    const tree = makeTree();
    const lua = path.join(tree.root, BRIDGE_FILES.serverLua);
    fs.writeFileSync(lua, fs.readFileSync(lua, "utf8").replace("VERSION = \"1.2.3\"", "VERSION = \"1.2.9\""));
    expect(nextBridgeVersion(getBridgeVersionStatus(tree.root))).toBe("1.2.3");
  });

  it("bumps the lock's patch when the code changed", () => {
    const tree = makeTree();
    tree.changeCode("1.2.3");
    expect(nextBridgeVersion(getBridgeVersionStatus(tree.root))).toBe("1.2.4");
  });

  it("keeps a version already raised above the lock", () => {
    const tree = makeTree();
    tree.changeCode("1.3.0");
    expect(nextBridgeVersion(getBridgeVersionStatus(tree.root))).toBe("1.3.0");
  });

  it("validates an explicit release version against the same rules", () => {
    const unchanged = getBridgeVersionStatus(makeTree().root);
    expect(validateReleaseVersion(unchanged, "1.2.3")).toEqual([]);
    expect(validateReleaseVersion(unchanged, "1.2.4")[0]).toMatch(/no-op bump/);
    expect(validateReleaseVersion(unchanged, "1.2.2")[0]).toMatch(/below/);
    expect(validateReleaseVersion(unchanged, "1.2")[0]).toMatch(/SemVer/);

    const tree = makeTree();
    tree.changeCode("1.2.3");
    const changed = getBridgeVersionStatus(tree.root);
    expect(validateReleaseVersion(changed, "1.2.3")[0]).toMatch(/changed since 1\.2\.3.*next: 1\.2\.4/);
    expect(validateReleaseVersion(changed, "1.2.4")).toEqual([]);
    expect(validateReleaseVersion(changed, "2.0.0")).toEqual([]);
  });

  it("writes the lock with the current hash, and only for the version the files declare", () => {
    const tree = makeTree();
    tree.changeCode("1.2.4");
    expect(() => writeBridgeVersionLock(tree.root, "1.2.5")).toThrow(/declare 1\.2\.4, not 1\.2\.5/);

    writeBridgeVersionLock(tree.root, "1.2.4");
    const { lock } = readLock(tree.root);
    expect(lock).toEqual({ schema: 1, version: "1.2.4", codeSha256: computeCodeSha256(tree.root) });
    expect(fs.readFileSync(path.join(tree.root, BRIDGE_FILES.lock), "utf8")).toMatch(/\n$/);
    const status = getBridgeVersionStatus(tree.root);
    expect(checkBridgeVersion(status, { release: true })).toEqual({ errors: [], notices: [] });
  });

  // Re-locking the locked number over changed code would give two different
  // bridges one version: Workshop servers would keep the old code and nothing
  // would tell them to update.
  it("refuses to re-lock the locked version over changed code", () => {
    const tree = makeTree();
    const lockPath = path.join(tree.root, BRIDGE_FILES.lock);
    const before = fs.readFileSync(lockPath, "utf8");
    tree.changeCode("1.2.3");
    expect(() => writeBridgeVersionLock(tree.root, "1.2.3"))
      .toThrow(/refusing to lock 1\.2\.3: PanelBridge code changed since 1\.2\.3; ship it as a newer version \(next: 1\.2\.4\).*release\.ps1/);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(before);
    expect(nextBridgeVersion(getBridgeVersionStatus(tree.root))).toBe("1.2.4");
  });

  it("refuses to lock a no-op bump or a version below the lock", () => {
    const tree = makeTree();
    const lua = path.join(tree.root, BRIDGE_FILES.serverLua);
    const declare = (version) => {
      fs.writeFileSync(lua, fs.readFileSync(lua, "utf8")
        .replace(/Version: \d+\.\d+\.\d+/, `Version: ${version}`)
        .replace(/VERSION = "\d+\.\d+\.\d+"/, `VERSION = "${version}"`));
      fs.writeFileSync(path.join(tree.root, BRIDGE_FILES.modInfo), modInfo(version));
    };
    declare("1.2.4");
    expect(() => writeBridgeVersionLock(tree.root, "1.2.4")).toThrow(/refusing to lock 1\.2\.4: .*no-op bump/);
    declare("1.2.2");
    expect(() => writeBridgeVersionLock(tree.root, "1.2.2")).toThrow(/refusing to lock 1\.2\.2: 1\.2\.2 is below the released PanelBridge 1\.2\.3/);
    declare("1.2.3");
    expect(() => writeBridgeVersionLock(tree.root, "1.2.3")).not.toThrow();
  });

  it("still creates a lock that is missing or unreadable", () => {
    const tree = makeTree({ lock: false });
    tree.changeCode("1.2.3");
    writeBridgeVersionLock(tree.root, "1.2.3");
    expect(readLock(tree.root).lock).toMatchObject({ version: "1.2.3", codeSha256: computeCodeSha256(tree.root) });

    tree.write(BRIDGE_FILES.lock, "{ not json");
    tree.write(BRIDGE_FILES.serverLua, luaSource("1.2.3", "-- changed again"));
    writeBridgeVersionLock(tree.root, "1.2.3");
    expect(readLock(tree.root)).toMatchObject({ error: null, lock: { version: "1.2.3", codeSha256: computeCodeSha256(tree.root) } });
  });
});

describe("check-bridge-version: command line", () => {
  it("maps each mode to its exit code and output", () => {
    const tree = makeTree();
    tree.changeCode("1.2.3");
    const root = ["--root", tree.root];

    const pr = runCli(root);
    expect(pr.code).toBe(0);
    expect(pr.out).toMatch(/Notice: unreleased PanelBridge changes/);
    expect(runCli([...root, "--release"]).code).toBe(1);
    expect(runCli([...root, "--next"]).out).toBe("1.2.4");
    expect(runCli([...root, "--validate", "1.2.3"]).code).toBe(1);
    expect(runCli([...root, "--validate", "v1.2.4"]).code).toBe(0);
    expect(runCli([...root, "--bogus"]).code).toBe(2);

    const printed = JSON.parse(runCli([...root, "--print-json"]).out);
    expect(Object.keys(printed)).toEqual(["version", "lockVersion", "codeSha256", "lockSha256", "changed"]);
    expect(printed).toMatchObject({ version: "1.2.3", lockVersion: "1.2.3", changed: true });
  });

  it("runs as a script with the documented exit codes", () => {
    const tree = makeTree();
    const run = (...args) => {
      try {
        const out = execFileSync(process.execPath, [SCRIPT, "--root", tree.root, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, out };
      } catch (error) {
        return { code: error.status, out: `${error.stdout}${error.stderr}` };
      }
    };
    expect(run().code).toBe(0);
    expect(run("--next").out.trim()).toBe("1.2.3");
    tree.changeCode("1.2.3");
    expect(run("--release")).toMatchObject({ code: 1 });
    const relock = run("--write-lock", "1.2.3");
    expect(relock.code).toBe(1);
    expect(relock.out).toMatch(/PanelBridge version check failed: refusing to lock 1\.2\.3/);
    expect(run("--release").code).toBe(1);
    // What release.ps1 does: declare the next version, then lock it.
    tree.changeCode("1.2.4");
    expect(run("--write-lock", "1.2.4").code).toBe(0);
    expect(run("--release").code).toBe(0);
  });
});

describe("check-bridge-version: this repository", () => {
  it("has a well-formed lock and passes PR mode", () => {
    const { lock, error } = readLock(REPO_ROOT);
    expect(error).toBeNull();
    expect(lock.schema).toBe(1);
    const { errors } = checkBridgeVersion(getBridgeVersionStatus(REPO_ROOT));
    expect(errors).toEqual([]);
  });
});
