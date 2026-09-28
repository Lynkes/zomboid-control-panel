import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  scanBridgeStartFailure,
  scanSteamStartup,
  scanWorkshopFailures,
  scanWorkshopInstallFolder,
} from "../utils/workshopLogScan.js";
import { scanWorkshopFailures as reexported } from "../routes/debug.js";

// "Did the latest start abort while getting the PanelBridge Workshop item?"
// drives the workshop-start-failed state and its "switch back" action, so a
// failure must be attributed to the bridge's own item id (another item
// failing is not a reason to switch PanelBridge back), and a log from before
// the switch must never count.

const ID = "3712345678";
let zPath;

function writeLog(lines, mtime = null) {
  const logPath = path.join(zPath, "server-console.txt");
  fs.writeFileSync(logPath, lines.join("\r\n"));
  if (mtime) fs.utimesSync(logPath, mtime, mtime);
}

beforeEach(() => {
  zPath = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-log-scan-"));
});

afterEach(() => {
  fs.rmSync(zPath, { recursive: true, force: true });
});

describe("scanBridgeStartFailure", () => {
  it("attributes an onItemNotDownloaded line to the bridge item and captures the result", () => {
    writeLog([
      "LOG  : General , 1 > Workshop: onItemNotDownloaded itemID=111 result=2",
      `LOG  : General , 2 > Workshop: onItemNotDownloaded itemID=${ID} result=9`,
      "LOG  : General , 3 > Something else",
    ]);
    const failure = scanBridgeStartFailure(zPath, ID);
    expect(failure).toMatchObject({ kind: "itemDownload", result: 9 });
    expect(failure.line).toContain(`itemID=${ID}`);
    expect(Date.parse(failure.logMtime)).not.toBeNaN();
  });

  it("does not blame the bridge for another item's failure", () => {
    writeLog(["Workshop: onItemNotDownloaded itemID=111 result=9", `Workshop: onItemNotDownloaded itemID=${ID}0 result=9`]);
    expect(scanBridgeStartFailure(zPath, ID)).toBeNull();
  });

  it("recognises the GetItemInstallFolder failure for the bridge id", () => {
    writeLog([`Workshop: GetItemInstallFolder() failed ID=${ID}`]);
    expect(scanBridgeStartFailure(zPath, ID)).toMatchObject({ kind: "itemDownload", result: null });
  });

  it("reports Steam being unreachable, which aborts before any item downloads", () => {
    writeLog(["SteamGameServer: Failed to connect to Steam servers"]);
    expect(scanBridgeStartFailure(zPath, ID)).toMatchObject({ kind: "steamUnreachable", result: null });
  });

  it("ignores a log older than the switch (mtime guard)", () => {
    writeLog([`Workshop: onItemNotDownloaded itemID=${ID} result=9`], new Date("2026-01-01T00:00:00Z"));
    expect(scanBridgeStartFailure(zPath, ID, { notBefore: "2026-02-01T00:00:00Z" })).toBeNull();
    expect(scanBridgeStartFailure(zPath, ID, { notBefore: "2025-12-01T00:00:00Z" })).toMatchObject({
      kind: "itemDownload",
    });
  });

  it("trims the reported line to 300 characters", () => {
    writeLog([`Workshop: onItemNotDownloaded itemID=${ID} result=9 ${"x".repeat(500)}`]);
    expect(scanBridgeStartFailure(zPath, ID).line.length).toBe(300);
  });

  it("returns null with no log, no id, or a clean log", () => {
    expect(scanBridgeStartFailure(zPath, ID)).toBeNull();
    writeLog(["Workshop: 111 installed to /x"]);
    expect(scanBridgeStartFailure(zPath, ID)).toBeNull();
    expect(scanBridgeStartFailure(zPath, null)).toBeNull();
  });
});

describe("scanWorkshopInstallFolder", () => {
  it("returns the last folder reported for the bridge id", () => {
    writeLog([
      `Workshop: ${ID} installed to /old/place`,
      "Workshop: 111 installed to /other",
      `Workshop: ${ID} installed to /pz-server/steamapps/workshop/content/108600/${ID}`,
    ]);
    expect(scanWorkshopInstallFolder(zPath, ID)).toBe(`/pz-server/steamapps/workshop/content/108600/${ID}`);
  });

  // 42.20 writes the id first and the folder second
  // (GameServerWorkshopItems.Install, bytecode 476-485), so a line the other
  // way round isn't the engine's and names no folder for the item.
  it("answers null for a line that doesn't start with the id", () => {
    writeLog([`Workshop: /pz-server/steamapps/workshop/content/108600/${ID} installed to ${ID}`]);
    expect(scanWorkshopInstallFolder(zPath, ID)).toBeNull();
  });

  // The 42.21 live test: the line sat at byte ~11 KB of a 276 KB console by
  // SERVER STARTED (the Workshop phase comes before the world loads), out of
  // the 256 KB tail every reader here used to look at.
  it("finds the line near the top of a console that has grown past the tail window", () => {
    const folder = `D:\\SteamLibrary\\steamapps\\common\\ProjectZomboid\\steamapps\\workshop\\content\\108600\\${ID}`;
    writeLog([
      ...filler(10 * 1024),
      `LOG  : General      f:0 st:1,127,700,001> Workshop: ${ID} installed to ${folder}`,
      ...filler(270 * 1024),
      "LOG  : General      f:0 st:1,127,736,001> *** SERVER STARTED ****",
    ]);
    expect(fs.statSync(path.join(zPath, "server-console.txt")).size).toBeGreaterThan(280 * 1024);
    expect(scanWorkshopInstallFolder(zPath, ID)).toBe(folder);
  });

  it("keeps its reads bounded, and never reports a folder cut at the head window's end", () => {
    const line = `Workshop: ${ID} installed to /pz-server/steamapps/workshop/content/108600/${ID}`;
    // Starts 20 bytes before the 1 MB head ends, so the head holds only part of it.
    const head = "x".repeat(1024 * 1024 - 20 - 2);
    writeLog([head, line, ...filler(600 * 1024)]);
    expect(scanWorkshopInstallFolder(zPath, ID)).toBeNull();

    // Past the head and before the tail: not read at all.
    writeLog([...filler(1100 * 1024), line, ...filler(300 * 1024)]);
    expect(scanWorkshopInstallFolder(zPath, ID)).toBeNull();
  });
});

// ~100-byte console lines adding up to about `bytes`.
function filler(bytes) {
  const line = `LOG  : General      f:0 st:1,127,650,000> ${"-".repeat(56)}`;
  return Array.from({ length: Math.ceil(bytes / (line.length + 2)) }, () => line);
}

describe("scanSteamStartup", () => {
  // The live test's two runs: the client install's ProjectZomboidServer.bat
  // (no -Dzomboid.steam=1), then the dedicated server's own launch.
  it("finds the game saying it started without Steam, near the top of a long console", () => {
    writeLog([
      "LOG  : General      f:0 st:1,127,642,222> Loading ZNetNoSteam64...",
      "LOG  : General      f:0 st:1,127,642,271> SteamUtils started without Steam",
      "WARN : Mod          f:0 st:1,127,648,143 at ZomboidFileSystem.loadModAndRequired> required mod \"ZCPB\" not found",
      ...filler(300 * 1024),
    ]);
    expect(scanSteamStartup(zPath)).toEqual({
      steam: false,
      line: "LOG  : General      f:0 st:1,127,642,271> SteamUtils started without Steam",
    });
  });

  it("finds a Steam-mode start", () => {
    writeLog([
      "LOG  : General      f:0 st:1,127,736,433> Loading ZNetJNI64...",
      "LOG  : General      f:0 st:1,127,736,453> SteamUtils initialised successfully",
      ...filler(300 * 1024),
    ]);
    expect(scanSteamStartup(zPath)).toEqual({
      steam: true,
      line: "LOG  : General      f:0 st:1,127,736,453> SteamUtils initialised successfully",
    });
  });

  it("returns null for no log, a log with neither line, or a log older than the switch", () => {
    expect(scanSteamStartup(zPath)).toBeNull();
    writeLog(["LOG  : General      f:0> Loading world..."]);
    expect(scanSteamStartup(zPath)).toBeNull();
    writeLog(["LOG  : General      f:0> SteamUtils started without Steam"], new Date("2026-01-01T00:00:00Z"));
    expect(scanSteamStartup(zPath, { notBefore: "2026-02-01T00:00:00Z" })).toBeNull();
    expect(scanSteamStartup(zPath, { notBefore: "2025-12-01T00:00:00Z" })).toMatchObject({ steam: false });
  });
});

describe("scanWorkshopFailures (moved from routes/debug.js)", () => {
  it("is still exported from routes/debug.js as the same function", () => {
    expect(reexported).toBe(scanWorkshopFailures);
  });

  it("still lists failed ids and the crash marker", async () => {
    writeLog(["Workshop: onItemNotDownloaded itemID=111 result=9", "at GameServerWorkshopItems.Install"]);
    const result = await scanWorkshopFailures(zPath);
    expect(result).toMatchObject({ ids: ["111"], results: { 111: 9 }, crashed: true });
  });
});
