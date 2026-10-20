import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, startApp, tokenWithCapabilities } from "./helpers/authzHarness.js";
import { DEFAULT_INI_EXCLUSIONS, isIniKeyExcluded } from "../utils/templateSchema.js";
import { INI_KEY_CAPABILITY } from "../utils/iniKeyCapability.js";

// SECURITY (2026-10-20, access-control audit): a templates.manage-only role
// imported a template whose serverIni held DiscordToken, UPnP, Mods and
// WorkshopItems, and applying it rewrote all four -- keys server.configure,
// mods.manage and integrations.manage govern everywhere else. And POST
// /:id/preview answered a role with no capability at all, returning the live
// DiscordToken in the diff. Those keys (and anything secret-like, by
// pattern, in any case) are now excluded from templates, preview needs
// templates.manage, and every read leaves an excluded key out.

const { default: templatesRouter } = await import("../routes/templates.js");

const INI_LINES = [
  "DiscordToken=BOT_TOKEN_SECRET_123",
  "DiscordEnable=false",
  "UPnP=false",
  "Mods=",
  "WorkshopItems=",
  "Map=Muldraugh, KY",
  "DoLuaChecksum=true",
  "RCONPassword=rconpw",
  "PauseEmpty=true",
  "PVP=true",
  "",
];

let base;
let iniPath;
let server;
let app;
let manager;
let nobody;

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-boundary-"));
  for (const dir of ["Saves", "Lua", "db", "Server"]) fs.mkdirSync(path.join(base, dir), { recursive: true });
  iniPath = path.join(base, "Server", "servertest.ini");
  fs.writeFileSync(iniPath, INI_LINES.join("\n"));
  server = await init.createServer({
    name: "Prod",
    serverName: "servertest",
    installPath: path.join(base, "install"),
    zomboidDataPath: base,
    serverConfigPath: path.join(base, "Server"),
    rconHost: "127.0.0.1",
    rconPort: 27015,
    rconPassword: "x",
    isRemote: false,
  });
  await init.setActiveServer(server.id);
  manager = await tokenWithCapabilities(["templates.manage"]);
  nobody = await tokenWithCapabilities([]);
  app = await startApp([["/api/templates", templatesRouter]], {
    serverManager: {
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
      reloadConfig: async () => {},
    },
  });
});

afterAll(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

function templateWith(serverIni) {
  return {
    schemaVersion: 1,
    meta: { id: "x", name: "evil", tags: [] },
    sandboxVars: {},
    serverIni,
    iniExclusions: [],
    mods: [],
    map: {},
    difficulty: {},
  };
}

describe("the template ini floor", () => {
  it("holds every key INI_KEY_CAPABILITY governs, plus the mod, map and bridge keys", () => {
    for (const key of Object.keys(INI_KEY_CAPABILITY)) expect(DEFAULT_INI_EXCLUSIONS).toContain(key);
    for (const key of ["Mods", "WorkshopItems", "Map", "DoLuaChecksum"]) expect(DEFAULT_INI_EXCLUSIONS).toContain(key);
  });

  it("excludes secret-like keys by pattern and every key without case", () => {
    expect(isIniKeyExcluded("DiscordToken")).toBe(true);
    expect(isIniKeyExcluded("SomeModApiKey")).toBe(true);
    expect(isIniKeyExcluded("upnp")).toBe(true);
    expect(isIniKeyExcluded("MODS")).toBe(true);
    expect(isIniKeyExcluded("PVP")).toBe(false);
  });
});

describe("POST /api/templates/import", () => {
  it("refuses a template carrying keys other capabilities govern, whatever their case", async () => {
    for (const serverIni of [
      { DiscordToken: "attacker-token" },
      { UPnP: "true" },
      { Mods: "EvilMod" },
      { WorkshopItems: "123456789" },
      { upnp: "true" },
      { mods: "EvilMod" },
      { DoLuaChecksum: "false" },
    ]) {
      const res = await app.call("POST", "/api/templates/import", manager, { template: templateWith(serverIni) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SIM_TEMPLATE_VALIDATION_FAILED");
    }
  });
});

describe("a template stored before the floor grew (adversary pass)", () => {
  let templateId;
  beforeAll(async () => {
    const saved = await init.saveUserTemplate({
      ...templateWith({
        DiscordToken: "attacker-token",
        UPnP: "true",
        Mods: "EvilMod",
        WorkshopItems: "123456789",
        PVP: "false",
      }),
      meta: { id: "legacy-tpl", name: "legacy", tags: [] },
    });
    templateId = saved.meta.id;
  });

  it("is listed and read without the excluded keys", async () => {
    const list = await app.call("GET", "/api/templates", nobody);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("attacker-token");
    const one = await app.call("GET", `/api/templates/${templateId}`, nobody);
    expect(Object.keys(one.body.template.serverIni)).toEqual(["PVP"]);
  });

  it("preview is refused to a role without templates.manage", async () => {
    const res = await app.call("POST", `/api/templates/${templateId}/preview`, nobody, { serverId: server.id });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("BOT_TOKEN_SECRET_123");
  });

  it("preview for templates.manage never carries the live secret", async () => {
    const res = await app.call("POST", `/api/templates/${templateId}/preview`, manager, { serverId: server.id });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("BOT_TOKEN_SECRET_123");
    expect(res.body.diff.serverIni.map((change) => change.key)).toEqual(["PVP"]);
  });

  it("apply rewrites only the keys a template may carry", async () => {
    const res = await app.call("POST", `/api/templates/${templateId}/apply`, manager, { serverId: server.id });
    expect(res.status).toBe(200);
    const ini = fs.readFileSync(iniPath, "utf8");
    expect(ini).toContain("DiscordToken=BOT_TOKEN_SECRET_123");
    expect(ini).toContain("UPnP=false");
    expect(ini).toMatch(/^Mods=$/m);
    expect(ini).toMatch(/^WorkshopItems=$/m);
    expect(ini).toContain("PVP=false");
  });
});
