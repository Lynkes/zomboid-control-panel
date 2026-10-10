import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { runServerFilesRoute } from "./helpers/serverFilesRoute.js";

// POST /templates saves the ini WITHOUT its secret lines (RCONPassword, the
// join Password, every *Token ...: stripSensitiveIniLines), and POST
// /templates/:id/apply then wrote that snapshot over the live .ini as it was.
// So applying any saved config removed the live RCON password (RCON login
// failed from then on), the join password (the server was suddenly open) and
// every token line -- the confirm dialog only warned about the RCON password.
// Apply now puts the live file's secret lines into what it writes.

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

function runRoute(routePath, method, req) {
  return runServerFilesRoute(router, routePath, method, req, createResponse());
}

const SERVER_NAME = "TestApply";
let configDir;
let iniPath;

const liveIni = (overrides = {}) =>
  Object.entries({
    PVP: "true",
    RCONPassword: "rcon-at-save-time",
    Password: "join-at-save-time",
    DiscordToken: "token-at-save-time",
    DefaultPort: "16261",
    ...overrides,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";

beforeEach(() => {
  // PATHS-2: a config folder is used only inside <data folder>/Server.
  configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tpl-apply-secrets-")), "Server");
  fs.mkdirSync(configDir);
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  fs.writeFileSync(iniPath, liveIni());
  getActiveServer.mockReset().mockResolvedValue({
    zomboidDataPath: path.dirname(configDir),
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
});

const admin = { role: "admin" };
const saveTemplate = () =>
  runRoute("/templates", "post", {
    user: admin,
    body: { name: "Snapshot", includeIni: true, includeSandbox: false },
  });
const applyTemplate = (id) =>
  runRoute("/templates/:id/apply", "post", { user: admin, params: { id }, body: {} });

describe("POST /templates/:id/apply keeps the live ini's secret lines", () => {
  it("applies the template's settings and keeps the RCON password, the join password and the token", async () => {
    const id = (await saveTemplate()).getBody().id;
    fs.writeFileSync(iniPath, liveIni({ PVP: "false", DefaultPort: "16261" }));

    const res = await applyTemplate(id);

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe(
      "PVP=true\nDefaultPort=16261\nRCONPassword=rcon-at-save-time\nPassword=join-at-save-time\nDiscordToken=token-at-save-time\n",
    );
  });

  it("keeps the CURRENT secrets, not the ones that were live when the template was saved (a rotated password stays rotated)", async () => {
    const id = (await saveTemplate()).getBody().id;
    fs.writeFileSync(
      iniPath,
      liveIni({
        PVP: "false",
        RCONPassword: "Rotated$$Pa$&ss;1",
        Password: "new-join",
        DiscordToken: "new-token",
      }),
    );

    const res = await applyTemplate(id);

    expect(res.getStatusCode()).toBe(200);
    const written = fs.readFileSync(iniPath, "utf-8");
    expect(written).toContain("PVP=true\n");
    expect(written).toContain("\nRCONPassword=Rotated$$Pa$&ss;1\n");
    expect(written).toContain("\nPassword=new-join\n");
    expect(written).toContain("\nDiscordToken=new-token\n");
    expect(written).not.toContain("at-save-time");
    expect(written).not.toContain("•");
  });

  it("does not add a secret line the live file never had, and never writes the mask placeholder", async () => {
    // A template saved before secrets were left out: a real old password and a mask.
    fs.mkdirSync(path.join(configDir, "templates"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "templates", "old-format.json"),
      JSON.stringify({
        name: "Old",
        iniRaw: "PVP=true\nRCONPassword=old-real-rcon\nPassword=••••••••\nDefaultPort=1\n",
      }),
    );
    fs.writeFileSync(iniPath, "PVP=false\nRCONPassword=live-rcon\nDefaultPort=16261\n");

    const res = await applyTemplate("old-format");

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe("PVP=true\nRCONPassword=live-rcon\nDefaultPort=1\n");
  });

  it("writes the template as it is when there is no live ini yet", async () => {
    const id = (await saveTemplate()).getBody().id;
    fs.rmSync(iniPath);

    const res = await applyTemplate(id);

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe("PVP=true\nDefaultPort=16261\n");
  });

  it("backs up the live file first, secrets included", async () => {
    const id = (await saveTemplate()).getBody().id;
    fs.writeFileSync(iniPath, liveIni({ PVP: "false" }));

    await applyTemplate(id);

    const backupDir = path.join(configDir, "backups");
    const backups = fs.readdirSync(backupDir).filter((name) => name.startsWith(`${SERVER_NAME}.ini.`));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, backups[0]), "utf-8")).toBe(liveIni({ PVP: "false" }));
  });
});
