import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { runServerFilesRoute } from "./helpers/serverFilesRoute.js";

// POST /server-files/templates/:id/apply writes INI then Sandbox settings as
// two separate steps. If the INI write succeeds and the Sandbox write then
// fails, the route falls into its outer catch and responds with a flat
// { error } -- reading as "nothing happened" -- even though the INI file was
// already overwritten. Diagnosed during route-hunt Finding 4, confirmed
// still present: the `applied` array that WOULD tell the truth is
// only ever read on the success path.

const withFileLock = vi.fn(async (filePath, fn) => {
  if (String(filePath).includes("SandboxVars")) {
    throw new Error("boom-sandbox-write");
  }
  return fn();
});
const writeFileAtomic = vi.fn();

vi.mock("../utils/fileWriteQueue.js", () => ({ withFileLock, writeFileAtomic }));

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.js");

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

// Runs the route behind the router's own gate, which sets
// req.activeServerContext and fails the test if it refuses the request
// (helpers/serverFilesRoute.js).
function runRoute(routePath, method, req) {
  return runServerFilesRoute(router, routePath, method, req, createResponse());
}

const SERVER_NAME = "TestSave";
let configDir;

beforeEach(() => {
  // PATHS-2: a config folder is used only inside <data folder>/Server.
  configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tpl-apply-partial-")), "Server");
  fs.mkdirSync(path.join(configDir, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "templates", "tpl-1.json"),
    JSON.stringify({
      name: "My Template",
      iniRaw: "PVP=true\n",
      sandboxRaw: "SandboxVars = {\n  Zombies = 1,\n}\n",
    }),
  );
  getActiveServer.mockReset().mockResolvedValue({
    zomboidDataPath: path.dirname(configDir),
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
  withFileLock.mockClear();
  writeFileAtomic.mockClear();
});

afterEach(() => {
  fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
});

function postApply() {
  return runRoute("/templates/:id/apply", "post", {
    user: { role: "admin" },
    params: { id: "tpl-1" },
    body: {},
  });
}

describe("serverFiles.js POST /templates/:id/apply: a partial apply must not read as total failure", () => {
  it("reports which settings actually landed when the INI write succeeds but the Sandbox write then fails", async () => {
    const res = await postApply();

    // The INI write really did happen (writeFileAtomic was called for it)
    // before the Sandbox write threw.
    expect(writeFileAtomic).toHaveBeenCalledTimes(1);
    expect(String(writeFileAtomic.mock.calls[0][0])).toContain(`${SERVER_NAME}.ini`);

    const body = res.getBody();
    expect(body.success).toBe(false);
    expect(body.partiallyApplied).toEqual(["INI"]);
  });
});
