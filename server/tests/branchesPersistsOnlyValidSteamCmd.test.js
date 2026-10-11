import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { EventEmitter } from "events";

// The Update dialog on the Servers page asks GET /server/branches for the
// branch list as the operator types the SteamCMD folder, so every prefix of
// the path ("C:\", "C:\Ste", ...) arrived as ?steamcmdPath=. The route saved
// each one as the steamcmdPath setting before checking it existed, leaving a
// half-typed path behind as the configured SteamCMD folder. Only a folder that
// holds a SteamCMD binary may be saved; anything else just gets the fallback
// branch list.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const { getSettingMock, setSettingMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(),
  setSettingMock: vi.fn(),
}));
vi.mock("../database/init.js", () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const isWin = process.platform === "win32";
const savedPath = isWin ? "C:\\steamcmd-saved" : "/opt/steamcmd-saved";
const typedPrefix = isWin ? "C:\\Ste" : "/opt/Ste";
const realFolder = isWin ? "C:\\steamcmd-real" : "/opt/steamcmd-real";

async function getBranches(query) {
  const { default: router } = await import("../routes/server.js");
  const res = createResponse();
  await getRouteHandler(router, "/branches", "get")(
    { query, app: { get: () => undefined } },
    res,
  );
  return res;
}

beforeEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  setSettingMock.mockReset().mockResolvedValue(undefined);
  getSettingMock
    .mockReset()
    .mockImplementation(async (key) => (key === "steamcmdPath" ? savedPath : null));
});

describe("GET /api/server/branches -- which steamcmdPath gets saved", () => {
  it("does not save a typed prefix that is not a SteamCMD folder, and does not run SteamCMD", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const res = await getBranches({ steamcmdPath: typedPrefix });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ source: "fallback" }));
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not save an existing folder that has no SteamCMD binary in it", async () => {
    // The folder exists (so does a system-wide steamcmd on some Linux hosts),
    // but the binary is not inside it.
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const lower = String(p).toLowerCase();
      return lower === typedPrefix.toLowerCase() || lower.startsWith("/usr/");
    });

    const res = await getBranches({ steamcmdPath: typedPrefix });

    expect(res.getBody()).toEqual(expect.objectContaining({ source: "fallback" }));
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("saves a folder that holds SteamCMD before running it", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p).toLowerCase().includes("steamcmd"));
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    await getBranches({ steamcmdPath: realFolder });

    expect(setSettingMock).toHaveBeenCalledWith("steamcmdPath", realFolder);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps using an already-saved path without saving anything", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p).toLowerCase().includes("steamcmd"));
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    await getBranches({});

    expect(setSettingMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
