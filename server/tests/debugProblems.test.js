import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// GET /api/debug/problems ("Problems found" on the Diagnostics page): gated
// like every read of the page (diagnostics.manage), reads the active
// server's latest game log from its data folder only, and redacts what it
// quotes.

const getRoleByName = vi.fn(async (name) =>
  name === "diagnostics_only"
    ? { capabilities: ["diagnostics.manage"] }
    : name === "no_diagnostics"
      ? { capabilities: ["server.control"] }
      : mockGetRoleByName(name),
);
const getActiveServer = vi.fn(async () => null);

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return { ...actual, getRoleByName, getActiveServer };
});

const { default: debugRouter } = await import("../routes/debug.js");
const { scanServerProblems, readLatestGameLog } = await import("../services/serverProblems.js");

function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status(code) {
      statusCode = code;
      return response;
    },
    json(payload) {
      body = payload;
      return response;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return response;
}

async function getProblems(role) {
  const layer = debugRouter.stack.find((entry) => entry.route?.path === "/problems" && entry.route.methods.get);
  if (!layer) throw new Error("No GET /problems route registered");
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  const req = { user: { role }, params: {}, query: {}, body: {}, app: { get: () => undefined } };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("GET /problems", () => {
  beforeEach(() => {
    getRoleByName.mockClear();
    getActiveServer.mockClear();
  });

  it("refuses a role without diagnostics.manage", async () => {
    const res = await getProblems("no_diagnostics");
    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody()).not.toHaveProperty("findings");
  });

  it("answers with no findings and says the game log was not found when no server is set up", async () => {
    const res = await getProblems("diagnostics_only");
    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.findings).toEqual([]);
    expect(body.counts).toMatchObject({ critical: 0, warning: 0, info: 0 });
    expect(body.checked.gameLog).toMatchObject({ found: false });
  });
});

describe("scanServerProblems", () => {
  let dataDir;
  let configDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-problems-"));
    configDir = path.join(dataDir, "Server");
    fs.mkdirSync(configDir);
    fs.mkdirSync(path.join(dataDir, "mods", "LocalThing", "42", "media"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "mods", "LocalThing", "42", "mod.info"), "name=Local Thing\nid=LocalThing\n");
    fs.writeFileSync(path.join(configDir, "srv.ini"), "Mods=LocalThing\nWorkshopItems=\nDefaultPort=16300\n");
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads server-console.txt, attributes a Lua error to the local mod and redacts the samples", async () => {
    fs.writeFileSync(
      path.join(dataDir, "server-console.txt"),
      [
        "LOG  : General      f:0, t:1774895890000, st:0> versionNumber=42.21.0 demo=false",
        "ERROR: General      f:0, t:1774895897563, st:0> KahluaThread.flushErrorMessage      > dumping Lua stack trace",
        "-----------------------------------------",
        "STACK TRACE",
        "-----------------------------------------",
        "function: onTick -- file: LocalThing.lua line # 5 | MOD: Local Thing.",
        "ERROR: General      f:0, t:1774895897564, st:0> ExceptionLogger.logException> Exception thrown",
        "\tjava.lang.RuntimeException: attempted index: x of non-table: null at KahluaThread.tableget(KahluaThread.java:1540).",
        "ERROR: Network      f:0, t:1774895897600, st:0> Login> rejected 198.51.100.4 SuperSecretRcon",
        "LOG  : General      f:0, t:1774895897700, st:0> RakNet.Startup() return code: 5 (0 means success)",
      ].join("\r\n"),
    );
    const result = await scanServerProblems({
      activeServer: { id: 3, name: "Main", serverName: "srv", maxMemory: 6, serverPort: null },
      zomboidDataPath: dataDir,
      serverPath: null,
      iniPath: path.join(configDir, "srv.ini"),
      running: true,
      panelLog: [],
      redact: (text) => text.replaceAll("SuperSecretRcon", "[REDACTED]"),
      hostMemoryGb: 16,
    });
    expect(result.checked.gameLog).toMatchObject({ found: true, file: "server-console.txt" });
    expect(result.checked.modList).toBe(true);
    const lua = result.findings.find((f) => f.kind === "luaError");
    expect(lua).toMatchObject({ modId: "LocalThing", message: "attempted index: x of non-table: null" });
    expect(lua.fixes[0]).toMatchObject({ action: "disableMod", params: { modId: "LocalThing" } });
    const port = result.findings.find((f) => f.kind === "portInUse");
    expect(port.params).toEqual({ code: 5, port: 16300 });
    const text = JSON.stringify(result);
    expect(text).not.toContain("SuperSecretRcon");
    expect(text).not.toContain("198.51.100.4");
  });

  it("falls back to the newest Logs/*DebugLog-server.txt when server-console.txt is missing", async () => {
    const logs = path.join(dataDir, "Logs");
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, "2026-10-19_08-00_DebugLog-server.txt"), "LOG  : General      f:0> Failed to connect to Steam servers\n");
    fs.writeFileSync(path.join(logs, "2026-10-19_08-00_chat.txt"), "Failed to connect to Steam servers\n");
    const read = readLatestGameLog(dataDir);
    expect(read.file).toBe("Logs/2026-10-19_08-00_DebugLog-server.txt");
    const result = await scanServerProblems({ activeServer: null, zomboidDataPath: dataDir, running: null });
    expect(result.findings.map((f) => f.kind)).toEqual(["steamUnreachable"]);
  });

  it("reads nothing without a data folder (refused by the data-folder rule)", async () => {
    fs.writeFileSync(path.join(dataDir, "server-console.txt"), "LOG  : General      f:0> Failed to connect to Steam servers\n");
    const result = await scanServerProblems({ activeServer: null, zomboidDataPath: null });
    expect(result.findings).toEqual([]);
    expect(result.checked.gameLog).toMatchObject({ found: false, reason: "noDataFolder" });
  });
});
