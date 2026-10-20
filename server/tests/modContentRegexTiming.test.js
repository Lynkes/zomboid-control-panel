import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { ModChecker } from "../services/modChecker.js";
import { readModIds, buildSandboxOptionsDiagnostics } from "../routes/debug.js";
import { extractWorkshopModId } from "../routes/mods.js";
import { MOD_INFO_MAX_BYTES, modInfoName } from "../utils/modInfoText.js";

// Security audit 2026-10-20 (ReDoS from a Workshop item): the panel matched
// backtracking regexes against text a Workshop author controls.
//   - modChecker's /^\s*name\s*=\s*(.+)$/m over a whole, uncapped mod.info:
//     160 KB of blank lines blocked the event loop for ~16 s, at every panel
//     start (autoSyncModsOnStartup) and every update check.
//   - the diagnostics' /^id\s*=\s*(.+?)\s*$/i on one long id= line with
//     inner spaces (quadratic).
//   - the Workshop-description /\[code\][\s\S]*?id\s*=...[\s\S]*?\[\/code\]/i
//     (cubic: 2.7 s at 16,000 characters).
//   - the support bundle's /\bversion=([^\s]+)\s+b[0-9a-f]+/i over the console
//     log's tail, which a mod can print a "version=version=..." line into.
// Each now finishes in well under 100 ms on those inputs.

const BUDGET_MS = 100;

function fastest(run, times = 3) {
  let best = Infinity;
  let result;
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    result = run();
    best = Math.min(best, performance.now() - started);
  }
  return { ms: best, result };
}

async function fastestAsync(run, times = 3) {
  let best = Infinity;
  let result;
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    result = await run();
    best = Math.min(best, performance.now() - started);
  }
  return { ms: best, result };
}

describe("modChecker.resolveModNameFromDisk: a hostile mod.info", () => {
  let root;
  let checker;
  let modDir;
  const workshopId = "3000000001";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-modinfo-redos-"));
    modDir = path.join(root, "steamapps", "workshop", "content", "108600", workshopId, "mods", "EvilMod");
    fs.mkdirSync(modDir, { recursive: true });
    const acf = path.join(root, "steamapps", "workshop", "appworkshop_108600.acf");
    fs.writeFileSync(acf, '"AppWorkshop"\n{\n}\n');
    checker = new ModChecker();
    checker.workshopAcfPath = acf;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeModInfo = (text) => fs.writeFileSync(path.join(modDir, "mod.info"), text);

  it("the auditor's 160 KB of blank lines resolves (to the folder name) in under 100 ms", () => {
    writeModInfo("\r\n".repeat(80000) + "id=EvilMod\r\n");
    const { ms, result } = fastest(() => checker.resolveModNameFromDisk(workshopId, true));
    expect(result).toBe("EvilMod");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("whitespace-only lines of every kind, and a long name line with inner spaces, stay fast", () => {
    writeModInfo(" \t\r\n".repeat(15000) + "name=" + "a ".repeat(30000) + "\n");
    const { ms } = fastest(() => checker.resolveModNameFromDisk(workshopId, true));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("a multi-megabyte mod.info is read only up to the cap", () => {
    writeModInfo("name=Capped Mod\n" + "x".repeat(8 * 1024 * 1024) + "\n");
    const { ms, result } = fastest(() => checker.resolveModNameFromDisk(workshopId, true));
    expect(result).toBe("Capped Mod");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("a name= past the cap is not read; the folder name stands in", () => {
    writeModInfo("\n".repeat(MOD_INFO_MAX_BYTES + 10) + "name=Too Late\n");
    expect(checker.resolveModNameFromDisk(workshopId, true)).toBe("EvilMod");
  });

  // Adversary pass: with the read capped, the one input left that could stall
  // the read itself is a FIFO, which open() waits on for a writer forever.
  it.skipIf(process.platform === "win32")("a FIFO named mod.info is refused instead of blocking", () => {
    execFileSync("mkfifo", [path.join(modDir, "mod.info")]);
    expect(checker.resolveModNameFromDisk(workshopId, true)).toBe("EvilMod");
  });

  it("still reads an ordinary mod.info the way the old regex did", () => {
    writeModInfo("﻿  \r\nid=Real\r\n  name =  Real Mod Name  \r\nname=Second\r\n");
    expect(checker.resolveModNameFromDisk(workshopId, true)).toBe("Real Mod Name");
  });
});

describe("modInfoName", () => {
  it("skips an empty name= and takes the next one, and ignores keys that only start with name", () => {
    expect(modInfoName("names=Nope\nname=\nname = Yes\n")).toBe("Yes");
    expect(modInfoName("id=x\n")).toBeNull();
  });
});

describe("diagnostics readModIds: a hostile id= line", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-modids-redos-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a 40,000-space id= value is read in under 100 ms", async () => {
    const file = path.join(dir, "mod.info");
    fs.writeFileSync(file, "id=a" + " ".repeat(40000) + "b\n");
    const { ms, result } = await fastestAsync(() => readModIds(file, "Folder"));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual(["a" + " ".repeat(40000) + "b", "Folder"]);
  });

  it("keeps reading every id= (any case, trimmed) plus the folder name", async () => {
    const file = path.join(dir, "mod.info");
    fs.writeFileSync(file, "﻿name=X\r\n ID = First \r\nid=\r\nid=Second\r\n#id=Commented\r\n");
    expect(await readModIds(file, "Folder")).toEqual(["First", "Second", "Folder"]);
  });
});

describe("extractWorkshopModId: a hostile Workshop description", () => {
  it("16,000 characters of unclosed [code]id= blocks are read in under 100 ms", () => {
    // "a." fails the earlier patterns' id check, so the [code] pattern runs.
    const description = "[code]id=a. ".repeat(Math.floor(16000 / 12));
    const { ms, result } = fastest(() => extractWorkshopModId(description, ""));
    expect(result).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("still finds the id inside a [code] block", () => {
    expect(extractWorkshopModId("Install!\n[CODE]\nWorkshop ID: 1\nid=Real_Mod-2[/code]", "")).toBe("Real_Mod-2");
    expect(extractWorkshopModId("[code] mod id=Ok.x [/code] id=Ok2 [/code]", "")).toBe(null);
    expect(extractWorkshopModId("[code]id=a.b [code]id=Late[/code]", "")).toBe(null);
  });
});

describe("support bundle sandbox diagnostics: a hostile console log line", () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-version-redos-"));
    fs.mkdirSync(path.join(dataDir, "Server"));
    fs.writeFileSync(path.join(dataDir, "Server", "servertest.ini"), "Mods=\nWorkshopItems=\n");
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const diagnose = () =>
    buildSandboxOptionsDiagnostics({
      name: "servertest",
      serverName: "servertest",
      serverConfigPath: path.join(dataDir, "Server"),
      zomboidDataPath: dataDir,
    });

  it("a 512 KB line of version=version=... is scanned in well under a second", async () => {
    fs.writeFileSync(path.join(dataDir, "server-console.txt"), "version=".repeat(64 * 1024));
    const started = performance.now();
    const result = await diagnose();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.available).toBe(true);
    expect(result.pzVersion).toBeNull();
  });

  it("still reads the real version line", async () => {
    fs.writeFileSync(
      path.join(dataDir, "server-console.txt"),
      "LOG  : General      f:0> version=42.20.4 b0bbce05d5 demo=false\n",
    );
    expect((await diagnose()).pzVersion).toBe("42.20.4");
  });
});
