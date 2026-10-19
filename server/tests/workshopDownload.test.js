import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

// A mod added by URL whose mod IDs Steam's description does not state was added
// to WorkshopItems= only; the server downloaded it on the next boot, after it had
// read Mods=, so the mod was never enabled. downloadWorkshopItem() fetches the
// item with the SteamCMD the panel already has so its mod.info can be read first.

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

const {
  downloadWorkshopItem,
  parseWorkshopDownloadOutput,
  WorkshopDownloadReason,
} = await import("../services/workshopDownload.js");
const { getActiveSteamOperations } = await import("../services/activeSteamOperations.js");

const WS_ID = "3519629457";

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = vi.fn(() => child.emit("close", null));
  const spawn = vi.fn(() => child);
  return { spawn, child };
}

let root;
let steamcmdDir;
let serverDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-download-"));
  steamcmdDir = path.join(root, "steamcmd");
  serverDir = path.join(root, "server");
  fs.mkdirSync(steamcmdDir);
  fs.mkdirSync(serverDir);
  fs.writeFileSync(path.join(steamcmdDir, process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh"), "");
  getActiveSteamOperations().clear();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
  getActiveSteamOperations().clear();
});

describe("parseWorkshopDownloadOutput()", () => {
  it("reads SteamCMD's success and failure lines for the item", () => {
    expect(parseWorkshopDownloadOutput(`Success. Downloaded item ${WS_ID} to "C:\\x" (1234 bytes)`, WS_ID)).toEqual({ success: true });
    expect(parseWorkshopDownloadOutput(`ERROR! Download item ${WS_ID} failed (Failure).`, WS_ID)).toEqual({ success: false, detail: "Failure" });
    expect(parseWorkshopDownloadOutput("Success. Downloaded item 111 to x", WS_ID).success).toBe(false);
    expect(parseWorkshopDownloadOutput("", WS_ID)).toEqual({ success: false, detail: null });
  });
});

describe("downloadWorkshopItem()", () => {
  it("runs SteamCMD with an argument list: anonymous, the install folder, app 108600 and the item", async () => {
    const { spawn, child } = fakeSpawn();
    const pending = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => steamcmdDir });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(`Success. Downloaded item ${WS_ID} to "x" (10 bytes)\n`));
    child.emit("close", 0);

    expect(await pending).toEqual({ success: true });
    const [exe, args, options] = spawn.mock.calls[0];
    expect(path.dirname(exe)).toBe(steamcmdDir);
    expect(args).toEqual([
      "+force_install_dir", serverDir,
      "+login", "anonymous",
      "+workshop_download_item", "108600", WS_ID,
      "+quit",
    ]);
    expect(options.cwd).toBe(steamcmdDir);
    expect(options.shell).toBeUndefined();
    expect(getActiveSteamOperations().size).toBe(0); // the claim is released
  });

  it("claims the install folder while it runs, so an install or update is refused", async () => {
    const { spawn, child } = fakeSpawn();
    const pending = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => steamcmdDir });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(getActiveSteamOperations().get(path.normalize(serverDir).toLowerCase())?.type).toBe("workshop-download");
    child.emit("close", 0);
    await pending;
  });

  it("reports SteamCMD's own reason when the download fails", async () => {
    const { spawn, child } = fakeSpawn();
    const pending = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => steamcmdDir });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(`ERROR! Download item ${WS_ID} failed (No Connection).\n`));
    child.emit("close", 1);

    const result = await pending;
    expect(result).toMatchObject({ success: false, reason: WorkshopDownloadReason.FAILED });
    expect(result.error).toContain("No Connection");
  });

  it("counts the files on disk when SteamCMD ended without a success line (it relaunched after updating itself)", async () => {
    const { spawn, child } = fakeSpawn();
    const pending = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => steamcmdDir });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const itemDir = path.join(serverDir, "steamapps", "workshop", "content", "108600", WS_ID, "mods", "X");
    fs.mkdirSync(itemDir, { recursive: true });
    fs.writeFileSync(path.join(itemDir, "mod.info"), "id=X\n");
    child.stdout.emit("data", Buffer.from("[----] Update complete, launching Steamcmd...\n"));
    child.emit("close", 0);

    expect(await pending).toEqual({ success: true });
  });

  it("is not fooled by an empty folder or an explicit failure", async () => {
    const first = fakeSpawn();
    const pendingEmpty = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn: first.spawn, readSetting: async () => steamcmdDir });
    await vi.waitFor(() => expect(first.spawn).toHaveBeenCalled());
    first.child.emit("close", 0);
    expect(await pendingEmpty).toMatchObject({ success: false });

    fs.mkdirSync(path.join(serverDir, "steamapps", "workshop", "content", "108600", WS_ID, "mods"), { recursive: true });
    fs.writeFileSync(path.join(serverDir, "steamapps", "workshop", "content", "108600", WS_ID, "mods", "left-over.txt"), "");
    const second = fakeSpawn();
    const pendingFailed = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn: second.spawn, readSetting: async () => steamcmdDir });
    await vi.waitFor(() => expect(second.spawn).toHaveBeenCalled());
    second.child.stdout.emit("data", Buffer.from(`ERROR! Download item ${WS_ID} failed (Failure).\n`));
    second.child.emit("close", 1);
    expect(await pendingFailed).toMatchObject({ success: false });
  });

  it("does nothing without a saved SteamCMD, with a missing one, or while an install/update runs", async () => {
    const { spawn } = fakeSpawn();

    expect(await downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => null }))
      .toMatchObject({ success: false, reason: WorkshopDownloadReason.STEAMCMD_NOT_CONFIGURED });

    expect(await downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => path.join(root, "nowhere") }))
      .toMatchObject({ success: false, reason: WorkshopDownloadReason.STEAMCMD_NOT_FOUND });

    getActiveSteamOperations().set(path.normalize(serverDir).toLowerCase(), { type: "update", startTime: Date.now(), lastOutputAt: Date.now() });
    expect(await downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => steamcmdDir }))
      .toMatchObject({ success: false, reason: WorkshopDownloadReason.STEAM_OPERATION_ACTIVE });

    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a bad Workshop id and a server folder that is not there", async () => {
    const { spawn } = fakeSpawn();
    const readSetting = async () => steamcmdDir;
    expect(await downloadWorkshopItem("12ab; calc", { serverPath: serverDir, spawn, readSetting }))
      .toMatchObject({ reason: WorkshopDownloadReason.INVALID_ID });
    expect(await downloadWorkshopItem(WS_ID, { serverPath: path.join(root, "gone"), spawn, readSetting }))
      .toMatchObject({ reason: WorkshopDownloadReason.NO_SERVER_PATH });
    expect(await downloadWorkshopItem(WS_ID, { serverPath: "relative/dir", spawn, readSetting }))
      .toMatchObject({ reason: WorkshopDownloadReason.NO_SERVER_PATH });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills SteamCMD when it takes too long", async () => {
    vi.useFakeTimers();
    const { spawn, child } = fakeSpawn();
    const pending = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => steamcmdDir, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);

    expect(await pending).toMatchObject({ success: false, reason: WorkshopDownloadReason.TIMEOUT });
    expect(child.kill).toHaveBeenCalled();
    expect(getActiveSteamOperations().size).toBe(0);
  });

  it("kills SteamCMD when the request is cancelled", async () => {
    const { spawn, child } = fakeSpawn();
    const controller = new AbortController();
    const pending = downloadWorkshopItem(WS_ID, { serverPath: serverDir, spawn, readSetting: async () => steamcmdDir, signal: controller.signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    controller.abort();

    expect(await pending).toMatchObject({ success: false, reason: WorkshopDownloadReason.ABORTED });
    expect(child.kill).toHaveBeenCalled();
  });
});
