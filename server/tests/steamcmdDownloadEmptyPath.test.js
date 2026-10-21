import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// "Install SteamCMD automatically" with the path box left empty: the setup
// wizard sends installPath: "", and the route's destructuring default only
// applied to undefined, so "" reached isValidPath("") and was refused with
// STEAMCMD_DOWNLOAD_INVALID_PATH instead of using the default location.
//
// Linux branch forced (same convention as steamcmdDownloadConcurrency.test.js)
// so the download step is a mocked exec(), and os.homedir() points at a temp
// folder so the default (<home>/steamcmd) is created there, not in the real
// home folder.
const originalPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "linux", configurable: true });

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamcmd-empty-path-"));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exec: (...args) => execMock(...args) };
});

const { getSettingMock, setSettingMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(async () => null),
  setSettingMock: vi.fn(async () => {}),
}));
vi.mock("../database/init.js", () => ({
  getSetting: (...args) => getSettingMock(...args),
  setSetting: (...args) => setSettingMock(...args),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

afterEach(() => {
  setSettingMock.mockClear();
  execMock.mockReset();
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Fresh module per call: the route's single-flight flag stays claimed while
// the (never-finishing) mocked download is "running".
async function freshHandler() {
  vi.resetModules();
  const { default: router } = await import("../routes/server.js");
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/steamcmd/download" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

const io = { emit: vi.fn(), to: vi.fn() };
io.to.mockReturnValue(io);
const app = { get: (key) => (key === "io" ? io : undefined) };

describe("POST /api/server/steamcmd/download with an empty path field", () => {
  it.each([
    ["an empty string", ""],
    ["only spaces", "   "],
    ["no field at all", undefined],
  ])("uses the default location for %s", async (_label, installPath) => {
    execMock.mockImplementation(() => {});
    const handler = await freshHandler();
    const response = createResponse();

    await handler({ app, body: { installPath } }, response);

    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(setSettingMock).toHaveBeenCalledWith("steamcmdPath", path.join(tmpHome, "steamcmd"));
  });

  it("still refuses a relative path", async () => {
    execMock.mockImplementation(() => {});
    const handler = await freshHandler();
    const response = createResponse();

    await handler({ app, body: { installPath: "steamcmd" } }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "STEAMCMD_DOWNLOAD_INVALID_PATH" }),
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it("trims a typed path before using it", async () => {
    execMock.mockImplementation(() => {});
    const handler = await freshHandler();
    const response = createResponse();
    const typed = path.join(tmpHome, "typed-steamcmd");

    await handler({ app, body: { installPath: `  ${typed}  ` } }, response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(setSettingMock).toHaveBeenCalledWith("steamcmdPath", typed);
  });
});
