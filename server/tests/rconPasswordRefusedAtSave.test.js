import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// The panel stores the RCON password it logs in with, and ensureRconConfigured()
// writes the same text to RCONPassword= in the server .ini at every start. The
// game reads a .ini value only up to the first "=" and a line ends at a line
// break (utils/rconPassword.js), so a password with either can never be what
// the game has. It used to be saved anyway and written to the .ini with "="
// and ";" stripped: the game ran on a different password than the panel's and
// every RCON login failed with no hint why. Each place a password is saved now
// refuses it with RCON_PASSWORD_UNSUPPORTED_CHARS; everything else (";", "$",
// "#", quotes) is saved as typed.

const createServer = vi.fn();
const updateServer = vi.fn();
const getServer = vi.fn();
const getAllSettings = vi.fn();
const setSetting = vi.fn();
const getSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getServers: vi.fn(async () => []),
  getSetting,
  getAllSettings,
  setSetting,
  getServer,
  getActiveServer: vi.fn(async () => null),
  createServer,
  updateServer,
  deleteServer: vi.fn(),
  setActiveServer: vi.fn(),
  logServerEvent: vi.fn(async () => {}),
  getRoleByName: mockGetRoleByName,
}));

vi.mock("../services/rcon.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, testRconConnection: vi.fn() };
});

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials: vi.fn(),
}));

const { default: serversRouter } = await import("../routes/servers.js");
const { default: configRouter } = await import("../routes/config.js");
const { default: serverRouter } = await import("../routes/server.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Runs the route's whole middleware stack, permission gate included.
async function runRoute(router, routePath, method, req, res) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const REFUSED = [["ab=cd"], ["=x"], ["x="], ["a\nb"], ["a\rb"], ["a\r\nPublic=true"]];

beforeEach(() => {
  createServer.mockReset().mockResolvedValue({ id: "server-id", name: "Remote" });
  updateServer.mockReset().mockResolvedValue({ id: "server-id" });
  getServer.mockReset().mockResolvedValue({ id: "server-id", name: "Remote", rconPassword: "stored" });
  getAllSettings.mockReset().mockResolvedValue({});
  getSetting.mockReset().mockResolvedValue(null);
  setSetting.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/servers", () => {
  const body = (rconPassword) => ({
    name: "Remote",
    isRemote: true,
    rconHost: "10.0.0.5",
    rconPort: 27015,
    rconPassword,
  });

  it.each(REFUSED)("refuses %j with the translated code and creates nothing", async (password) => {
    const res = await runRoute(
      serversRouter, "/", "post",
      { body: body(password), user: { role: "admin" } },
      createResponse(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS);
    expect(createServer).not.toHaveBeenCalled();
  });

  it.each([["Pa$$w0rd;x#y"], ['q"uote'], ["  spaced  "]])("saves %j as typed", async (password) => {
    const res = await runRoute(
      serversRouter, "/", "post",
      { body: body(password), user: { role: "admin" } },
      createResponse(),
    );

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ rconPassword: password }));
  });
});

describe("PUT /api/servers/:id", () => {
  const put = (rconPassword) =>
    runRoute(
      serversRouter, "/:id", "put",
      { params: { id: "server-id" }, body: { rconPassword }, user: { role: "admin" } },
      createResponse(),
    );

  it.each(REFUSED)("refuses %j with the translated code and updates nothing", async (password) => {
    const res = await put(password);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS);
    expect(updateServer).not.toHaveBeenCalled();
  });

  it("saves a password with a semicolon and dollar signs as typed", async () => {
    const res = await put("Pa$$w0rd;x");

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(updateServer).toHaveBeenCalledWith(
      "server-id",
      expect.objectContaining({ rconPassword: "Pa$$w0rd;x" }),
    );
  });
});

describe("PUT /api/config/app-settings (the single-server settings)", () => {
  const app = { get: () => null };
  const put = (rconPassword) =>
    runRoute(
      configRouter, "/app-settings", "put",
      { body: { settings: { rconPassword } }, user: { role: "admin" }, app },
      createResponse(),
    );

  it.each(REFUSED)("refuses %j with the translated code and stores nothing", async (password) => {
    const res = await put(password);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("stores a password with a semicolon and dollar signs as typed", async () => {
    await put("Pa$$w0rd;x");

    expect(setSetting).toHaveBeenCalledWith("rconPassword", "Pa$$w0rd;x");
  });
});

describe("POST /api/server/install and /quick-setup", () => {
  // The password is judged before anything on disk is looked at, so a bare
  // body is enough to reach it.
  it.each(["/install", "/quick-setup"])("%s refuses a password with '=' before doing anything else", async (routePath) => {
    const res = await runRoute(
      serverRouter, routePath, "post",
      {
        body: { rconPassword: "ab=cd", installPath: "/does/not/exist", serverName: "servertest" },
        user: { role: "admin" },
        app: { get: () => ({ emit: vi.fn(), to: () => ({ emit: vi.fn() }) }) },
      },
      createResponse(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS);
    expect(setSetting).not.toHaveBeenCalled();
  });
});
