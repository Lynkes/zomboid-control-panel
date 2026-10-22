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
  // Left out rather than refused (bp5, 2026-10-20): an export from v1.4.17
  // carries most of them (below). Either way none of them is ever stored.
  it("never stores keys other capabilities govern, whatever their case", async () => {
    for (const serverIni of [
      { DiscordToken: "attacker-token" },
      { UPnP: "true" },
      { Mods: "EvilMod" },
      { WorkshopItems: "123456789" },
      { upnp: "true" },
      { mods: "EvilMod" },
      { DoLuaChecksum: "false" },
      { RCONPassword: "pw", DefaultPort: "1", SomeModApiKey: "k" },
    ]) {
      const res = await app.call("POST", "/api/templates/import", manager, {
        template: templateWith({ ...serverIni, PVP: "false" }),
      });
      expect(res.status).toBe(200);
      expect(res.body.droppedIniKeys).toEqual(Object.keys(serverIni));
      const stored = await init.getUserTemplate(res.body.template.meta.id);
      expect(stored.serverIni).toEqual({ PVP: "false" });
      expect(JSON.stringify(stored)).not.toContain("attacker-token");
    }
  });

  it("still refuses a template that is invalid for another reason", async () => {
    const res = await app.call("POST", "/api/templates/import", manager, {
      template: { ...templateWith({ Mods: "EvilMod" }), schemaVersion: 99 },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SIM_TEMPLATE_VALIDATION_FAILED");
  });

  it("still needs templates.manage", async () => {
    const res = await app.call("POST", "/api/templates/import", nobody, { template: templateWith({ PVP: "false" }) });
    expect(res.status).toBe(403);
  });
});

// v1.4.17's "Save as template" captured every .ini key but the eight it
// excluded then, so its exports carry Mods=, WorkshopItems=, Map=, UPnP=,
// DoLuaChecksum= and the Discord token's mask. Refusing them made every such
// export (a template shared between panels, or kept as a file) impossible to
// import after the upgrade.
describe("a template exported by v1.4.17", () => {
  const legacyExport = {
    schemaVersion: 1,
    meta: { id: "0b1c5d1e-legacy", name: "Our 2025 rules", description: "", tags: [], pzBuild: "42", createdAt: "2025-11-02T10:00:00.000Z" },
    sandboxVars: {},
    serverIni: {
      PVP: "true",
      PauseEmpty: "false",
      Mods: "EvilMod;OtherMod",
      WorkshopItems: "123456789",
      Map: "Riverside, KY",
      UPnP: "true",
      DoLuaChecksum: "false",
      DiscordToken: "••••••••",
    },
    iniExclusions: ["RCONPassword", "Password", "PublicName", "DefaultPort", "UDPPort", "RCONPort", "server_browser_announced_ip"],
    mods: [],
    map: { mapId: "Muldraugh, KY" },
    difficulty: {},
  };

  it("imports, without the keys a template may no longer carry", async () => {
    const res = await app.call("POST", "/api/templates/import", manager, { template: legacyExport });
    expect(res.status).toBe(200);
    expect(res.body.droppedIniKeys).toEqual(["Mods", "WorkshopItems", "Map", "UPnP", "DoLuaChecksum", "DiscordToken"]);
    expect(res.body.template.serverIni).toEqual({ PVP: "true", PauseEmpty: "false" });
    expect(res.body.template.meta.id).not.toBe(legacyExport.meta.id);
  });

  it("re-saved as a new template (POST /), gets the same treatment", async () => {
    const res = await app.call("POST", "/api/templates", manager, legacyExport);
    expect(res.status).toBe(200);
    expect(res.body.template.serverIni).toEqual({ PVP: "true", PauseEmpty: "false" });
  });

  it("applied, rewrites none of the governed keys (adversary pass)", async () => {
    const imported = await app.call("POST", "/api/templates/import", manager, { template: legacyExport });
    const res = await app.call("POST", `/api/templates/${imported.body.template.meta.id}/apply`, manager, { serverId: server.id });
    expect(res.status).toBe(200);
    const ini = fs.readFileSync(iniPath, "utf8");
    expect(ini).toContain("DiscordToken=BOT_TOKEN_SECRET_123");
    expect(ini).toContain("UPnP=false");
    expect(ini).toMatch(/^Mods=$/m);
    expect(ini).toMatch(/^WorkshopItems=$/m);
    expect(ini).toContain("Map=Muldraugh, KY");
    expect(ini).toContain("DoLuaChecksum=true");
    expect(ini).toContain("PauseEmpty=false");
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
