import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { maskSecretValue } from "../utils/sanitize.js";
import { runServerFilesRoute } from "./helpers/serverFilesRoute.js";

// PUT /ini refuses a change to RCONPassword, RCONPort, DefaultPort, UDPPort
// or UPnP from a caller without server.configure
// (serverFilesIniCapabilityPartition.test.js). The other three routes that
// write the same server .ini only needed serverfiles.manage:
//   - PUT /raw/ini        (the raw tab: "RCONPassword=whatever" in the text),
//   - POST /restore/:filename (restoring an older .ini backup),
//   - POST /templates/:id/apply (a saved config's ini over the live one),
// so a custom role with serverfiles.manage but not server.configure could set
// the RCON password or the game ports through any of them. Each now compares
// what the game reads for those keys before and after and needs the
// capability for any that would change -- on change, not on presence, so a
// whole-file save that leaves them alone is still allowed.

const ROLES = {
  admin: { capabilities: ["serverfiles.manage", "server.configure"] },
  // Passes the router's own gate and has nothing else.
  serverfiles_only: { capabilities: ["serverfiles.manage"] },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);
const getActiveServer = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName,
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

const SERVER_NAME = "TestIni";
let configDir;
let iniPath;
let backupDir;

function ini({ password = "old-rcon-pass", rconPort = "27015", defaultPort = "16261", pvp = "true" } = {}) {
  return [
    `PVP=${pvp}`,
    `RCONPassword=${password}`,
    `RCONPort=${rconPort}`,
    `DefaultPort=${defaultPort}`,
    "UDPPort=16262",
    "UPnP=true",
    "",
  ].join("\n");
}

beforeEach(() => {
  // PATHS-2: a config folder is used only inside <data folder>/Server.
  configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ini-cap-rra-")), "Server");
  fs.mkdirSync(configDir);
  backupDir = path.join(configDir, "backups");
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  fs.writeFileSync(iniPath, ini());
  getActiveServer.mockReset().mockResolvedValue({
    zomboidDataPath: path.dirname(configDir),
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
});

const onDisk = () => fs.readFileSync(iniPath, "utf-8");
const backupNames = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : []);

describe("PUT /server-files/raw/ini -- the governed keys need server.configure here too", () => {
  const putRaw = (content, role) =>
    runRoute("/raw/:type", "put", { user: { role }, params: { type: "ini" }, body: { content } });

  it("refuses a new RCONPassword from a caller without server.configure, writes nothing and makes no backup", async () => {
    const res = await putRaw(ini({ password: "attacker-chosen" }), "serverfiles_only");

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing).toEqual([
      { key: "RCONPassword", requiredCapability: "server.configure" },
    ]);
    expect(onDisk()).toBe(ini());
    expect(backupNames()).toEqual([]);
  });

  it("names every governed key the text changes and rejects atomically", async () => {
    const res = await putRaw(
      ini({ rconPort: "27099", defaultPort: "16999", pvp: "false" }),
      "serverfiles_only",
    );

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing).toEqual(
      expect.arrayContaining([
        { key: "RCONPort", requiredCapability: "server.configure" },
        { key: "DefaultPort", requiredCapability: "server.configure" },
      ]),
    );
    expect(onDisk()).toBe(ini()); // the allowed PVP change was not applied either
  });

  it("refuses removing a governed line, which hands the key back to the game's default", async () => {
    const res = await putRaw(ini().replace("RCONPort=27015\n", ""), "serverfiles_only");

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing).toEqual([
      { key: "RCONPort", requiredCapability: "server.configure" },
    ]);
    expect(onDisk()).toBe(ini());
  });

  it("refuses a governed line the game skipped before and reads now ('RCONPort =27099' -> 'RCONPort=27099')", async () => {
    fs.writeFileSync(iniPath, ini().replace("RCONPort=27015", "RCONPort =27099"));
    const res = await putRaw(ini({ rconPort: "27099" }), "serverfiles_only");

    expect(res.getStatusCode()).toBe(403);
  });

  it("allows the same RCONPassword change for a caller who also holds server.configure", async () => {
    const res = await putRaw(ini({ password: "chosen-by-admin" }), "admin");

    expect(res.getStatusCode()).toBe(200);
    expect(onDisk()).toContain("RCONPassword=chosen-by-admin");
  });

  it("allows a whole-file save that leaves every governed value alone, and keeps the masked RCONPassword line the editor sends back", async () => {
    const masked = maskSecretValue("old-rcon-pass");
    const res = await putRaw(ini({ password: masked, pvp: "false" }), "serverfiles_only");

    expect(res.getStatusCode()).toBe(200);
    expect(onDisk()).toBe(ini({ pvp: "false" }));
  });

  it("allows a reformatted file whose governed values read the same (CRLF, extra comment)", async () => {
    const res = await putRaw(`# edited\r\n${ini().replace(/\n/g, "\r\n")}`, "serverfiles_only");

    expect(res.getStatusCode()).toBe(200);
  });

  it("does not look at the other raw files: a SandboxVars edit needs only serverfiles.manage", async () => {
    fs.writeFileSync(path.join(configDir, `${SERVER_NAME}_SandboxVars.lua`), "SandboxVars = {\n}\n");
    const res = await runRoute("/raw/:type", "put", {
      user: { role: "serverfiles_only" },
      params: { type: "sandbox" },
      body: { content: "SandboxVars = {\n  Zombies = 1,\n}\n" },
    });

    expect(res.getStatusCode()).toBe(200);
  });
});

describe("POST /server-files/restore/:filename -- restoring an .ini backup needs server.configure for the governed keys it changes", () => {
  const backupName = `${SERVER_NAME}.ini.2024-01-01T12-00-00-000Z.bak`;
  const postRestore = (role, filename = backupName) =>
    runRoute("/restore/:filename", "post", { user: { role }, params: { filename } });

  function writeBackup(content, filename = backupName) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, filename), content);
  }

  it("refuses a backup holding another RCON password, leaving the live file and the backups as they were", async () => {
    writeBackup(ini({ password: "older-rcon-pass" }));

    const res = await postRestore("serverfiles_only");

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing).toEqual([
      { key: "RCONPassword", requiredCapability: "server.configure" },
    ]);
    expect(onDisk()).toBe(ini());
    expect(backupNames()).toEqual([backupName]);
  });

  it("refuses a backup holding other ports", async () => {
    writeBackup(ini({ rconPort: "27001", defaultPort: "16001" }));

    const res = await postRestore("serverfiles_only");

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing.map((m) => m.key).sort()).toEqual(["DefaultPort", "RCONPort"]);
    expect(onDisk()).toBe(ini());
  });

  it("restores the same backup for a caller who also holds server.configure", async () => {
    writeBackup(ini({ password: "older-rcon-pass" }));

    const res = await postRestore("admin");

    expect(res.getStatusCode()).toBe(200);
    expect(onDisk()).toBe(ini({ password: "older-rcon-pass" }));
  });

  it("restores a backup that differs only in non-governed settings for serverfiles.manage alone", async () => {
    writeBackup(ini({ pvp: "false" }));

    const res = await postRestore("serverfiles_only");

    expect(res.getStatusCode()).toBe(200);
    expect(onDisk()).toBe(ini({ pvp: "false" }));
  });

  it("does not look at backups of other files", async () => {
    const name = `${SERVER_NAME}_SandboxVars.lua.2024-01-01T12-00-00-000Z.bak`;
    writeBackup("SandboxVars = {\n  Zombies = 2,\n}\n", name);

    const res = await postRestore("serverfiles_only", name);

    expect(res.getStatusCode()).toBe(200);
  });
});

describe("POST /server-files/templates/:id/apply -- a template's ini needs server.configure for the governed keys it changes", () => {
  // What POST /templates saves: the ini without its secret lines.
  const withoutSecrets = (text) => text.replace(/^RCONPassword=.*\n/m, "");

  function writeTemplate(iniRaw) {
    fs.mkdirSync(path.join(configDir, "templates"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "templates", "tpl-1.json"),
      JSON.stringify({
        name: "Ports",
        iniRaw,
        sandboxRaw: "SandboxVars = {\n  Zombies = 1,\n}\n",
      }),
    );
  }
  const apply = (role) =>
    runRoute("/templates/:id/apply", "post", {
      user: { role },
      params: { id: "tpl-1" },
      body: {},
    });

  it("refuses a template that carries other ports and applies nothing, the sandbox file included", async () => {
    fs.writeFileSync(path.join(configDir, `${SERVER_NAME}_SandboxVars.lua`), "SandboxVars = {\n}\n");
    writeTemplate(withoutSecrets(ini({ rconPort: "27500", defaultPort: "16500" })));

    const res = await apply("serverfiles_only");

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody().missing.map((m) => m.key).sort()).toEqual(["DefaultPort", "RCONPort"]);
    expect(onDisk()).toBe(ini());
    expect(fs.readFileSync(path.join(configDir, `${SERVER_NAME}_SandboxVars.lua`), "utf-8")).toBe(
      "SandboxVars = {\n}\n",
    );
    expect(backupNames()).toEqual([]);
  });

  it("applies the same template for a caller who also holds server.configure", async () => {
    writeTemplate(withoutSecrets(ini({ rconPort: "27500" })));

    const res = await apply("admin");

    expect(res.getStatusCode()).toBe(200);
    expect(onDisk()).toContain("RCONPort=27500");
    // ...with the live RCON password kept (the template never holds it).
    expect(onDisk()).toContain("RCONPassword=old-rcon-pass");
  });

  it("applies a template that changes only non-governed settings for serverfiles.manage alone", async () => {
    writeTemplate(withoutSecrets(ini({ pvp: "false" })));

    const res = await apply("serverfiles_only");

    expect(res.getStatusCode()).toBe(200);
    expect(onDisk()).toBe(
      "PVP=false\nRCONPort=27015\nDefaultPort=16261\nUDPPort=16262\nUPnP=true\nRCONPassword=old-rcon-pass\n",
    );
  });
});
