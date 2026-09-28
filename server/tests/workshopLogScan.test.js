import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  scanBridgeStartFailure,
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

  it("answers null when the first placeholder is not the id (argument order unconfirmed)", () => {
    writeLog([`Workshop: /pz-server/steamapps/workshop/content/108600/${ID} installed to ${ID}`]);
    expect(scanWorkshopInstallFolder(zPath, ID)).toBeNull();
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
