import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The PanelBridge Lua mod keeps its files in Lua/panelbridge/<safe>/, where
// <safe> is the server name with / \ : * ? " < > | replaced by "_" and each run
// of whitespace by one "_" (PanelBridge.lua, getBasePath()). The panel looked
// for the name as typed, so a server called "AU-NZ AucklandApocalypse B42 -
// PvE" never auto-connected. Every lookup now goes through bridgeFolderName().

const state = vi.hoisted(() => ({ dataPath: null, installPath: null, serverName: "" }));

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  const server = () => ({
    id: 7,
    name: "Auckland profile",
    serverName: state.serverName,
    isRemote: false,
    zomboidDataPath: state.dataPath,
    installPath: state.installPath,
  });
  return {
    ...actual,
    getActiveServer: vi.fn(async () => server()),
    getServer: vi.fn(async () => server()),
    getAllSettings: vi.fn(async () => ({})),
  };
});

vi.mock("../services/bridgeDelivery.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    reconcileBridge: vi.fn(async () => ({ method: "local", skipped: null, actions: [], warnings: [] })),
  };
});

const { bridgeFolderName } = await import("../utils/bridgeFolderName.js");
const { tryStartPanelBridge } = await import("../index.js");
const { default: panelBridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runHandler(routePath, method, req) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res, () => {});
  return res;
}

describe("bridgeFolderName(): the folder PanelBridge.lua writes to", () => {
  it("leaves a plain name alone", () => {
    expect(bridgeFolderName("DoomerZ")).toBe("DoomerZ");
    expect(bridgeFolderName("servertest")).toBe("servertest");
    expect(bridgeFolderName("My-Server_01.b42")).toBe("My-Server_01.b42");
  });

  it("turns a space into an underscore", () => {
    expect(bridgeFolderName("AU-NZ AucklandApocalypse B42 - PvE")).toBe(
      "AU-NZ_AucklandApocalypse_B42_-_PvE",
    );
  });

  it("turns each run of whitespace into ONE underscore", () => {
    expect(bridgeFolderName("My   Server")).toBe("My_Server");
    expect(bridgeFolderName("My \t\r\n Server")).toBe("My_Server");
    expect(bridgeFolderName("  padded  ")).toBe("_padded_");
  });

  it("turns each path-hostile character into its own underscore", () => {
    expect(bridgeFolderName("a/b")).toBe("a_b");
    expect(bridgeFolderName("a\\b")).toBe("a_b");
    expect(bridgeFolderName("a:b*c?d\"e<f>g|h")).toBe("a_b_c_d_e_f_g_h");
    expect(bridgeFolderName("a//b")).toBe("a__b");
  });

  it("replaces special characters first, so a space beside one still collapses with the rest of its run", () => {
    // "a / b" -> "a _ b" -> every space is its own run: a, _, _, _, b
    expect(bridgeFolderName("a / b")).toBe("a___b");
    expect(bridgeFolderName("a  /  b")).toBe("a___b");
  });

  it("matches only the ASCII whitespace the game's Lua does", () => {
    // Kahlua's %s is 9-13 and 32; a no-break space stays as it is.
    const nbsp = String.fromCharCode(0xa0);
    expect(bridgeFolderName(`a${nbsp}b`)).toBe(`a${nbsp}b`);
    const accented = String.fromCharCode(0xef);
    expect(bridgeFolderName(`Zomb${accented}d Server`)).toBe(`Zomb${accented}d_Server`);
  });

  it("is empty for a missing or empty name (the mod then writes into panelbridge/ itself)", () => {
    expect(bridgeFolderName("")).toBe("");
    expect(bridgeFolderName(null)).toBe("");
    expect(bridgeFolderName(undefined)).toBe("");
    expect(path.join("Lua", "panelbridge", bridgeFolderName(""))).toBe(path.join("Lua", "panelbridge"));
  });

  it("stringifies like the Lua's tostring()", () => {
    expect(bridgeFolderName(1234)).toBe("1234");
  });

  it("stays identical to PanelBridge.lua: the Lua still uses these two substitutions", () => {
    const lua = fs.readFileSync(
      path.join(process.cwd(), "pz-mod", "PanelBridge", "media", "lua", "server", "PanelBridge.lua"),
      "utf8",
    );
    expect(lua).toContain('safeServerName:gsub("[/\\\\:%*%?\\"<>|]", "_")');
    expect(lua).toContain('safeServerName:gsub("%s+", "_")');
  });
});

describe("the panel finds a bridge folder whose name was made safe by the mod", () => {
  const NAME = "AU-NZ AucklandApocalypse B42 - PvE";
  const SAFE = "AU-NZ_AucklandApocalypse_B42_-_PvE";
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-bridge-folder-"));
    state.dataPath = path.join(root, "Zomboid");
    state.installPath = path.join(root, "pz", "server");
    state.serverName = NAME;
    fs.mkdirSync(path.join(state.dataPath, "Lua", "panelbridge", SAFE), { recursive: true });
    fs.writeFileSync(path.join(state.dataPath, "Lua", "panelbridge", SAFE, "status.json.txt"), "{}");
    fs.writeFileSync(path.join(state.dataPath, "Lua", "panelbridge", SAFE, "status.json"), "{}");
    fs.mkdirSync(state.installPath, { recursive: true });
    panelBridge.isRunning = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    panelBridge.isRunning = false;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("auto-starts on boot from the folder the mod made", async () => {
    const configure = vi.spyOn(panelBridge, "configure").mockImplementation(() => {});
    vi.spyOn(panelBridge, "start").mockImplementation(() => {});
    await expect(tryStartPanelBridge("startup")).resolves.toBe(true);
    expect(configure).toHaveBeenCalledWith(path.join(state.dataPath, "Lua", "panelbridge", SAFE), true);
  });

  it("auto-starts from the folder under the install path too", async () => {
    fs.rmSync(path.join(state.dataPath, "Lua"), { recursive: true, force: true });
    const viaInstall = path.join(state.installPath, "Lua", "panelbridge", SAFE);
    fs.mkdirSync(viaInstall, { recursive: true });
    fs.writeFileSync(path.join(viaInstall, "status.json"), "{}");
    const configure = vi.spyOn(panelBridge, "configure").mockImplementation(() => {});
    vi.spyOn(panelBridge, "start").mockImplementation(() => {});
    await expect(tryStartPanelBridge("startup")).resolves.toBe(true);
    expect(configure).toHaveBeenCalledWith(viaInstall, true);
  });

  it("POST /auto-configure picks that folder, with its status.json", async () => {
    const configure = vi.spyOn(panelBridge, "configure").mockImplementation((p) => p);
    vi.spyOn(panelBridge, "start").mockImplementation(() => {});
    const res = await runHandler("/auto-configure", "post", { body: {} });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.hasStatus).toBe(true);
    expect(body.bridgePath).toBe(path.join(state.dataPath, "Lua", "panelbridge", SAFE));
    expect(configure).toHaveBeenCalledWith(path.join(state.dataPath, "Lua", "panelbridge", SAFE), true);
    // and every path it searched names the safe folder, never the raw name
    for (const searched of body.searchedPaths) {
      expect(searched.path.endsWith(SAFE)).toBe(true);
    }
  });

  it("GET /scan-server/:id recommends that folder and lists only safe-named candidates", async () => {
    const res = await runHandler("/scan-server/:serverId", "get", { params: { serverId: "7" } });
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.recommendedPath).toBe(path.join(state.dataPath, "Lua", "panelbridge", SAFE));
    expect(body.paths.length).toBeGreaterThan(0);
    for (const candidate of body.paths) {
      expect(candidate.path.endsWith(SAFE)).toBe(true);
    }
  });

  it("autoDetect() finds it from the server name as typed", () => {
    const configure = vi.spyOn(panelBridge, "configure").mockImplementation((p) => p);
    expect(panelBridge.autoDetect(NAME, state.dataPath)).toBe(
      path.join(state.dataPath, "Lua", "panelbridge", SAFE),
    );
    expect(configure).toHaveBeenCalledWith(path.join(state.dataPath, "Lua", "panelbridge", SAFE), true);
  });

  it("autoDetect() still finds a plain name, and still says which name it could not find", () => {
    const plain = path.join(state.dataPath, "Lua", "panelbridge", "DoomerZ");
    fs.mkdirSync(plain, { recursive: true });
    vi.spyOn(panelBridge, "configure").mockImplementation((p) => p);
    expect(panelBridge.autoDetect("DoomerZ", state.dataPath)).toBe(plain);
    expect(() => panelBridge.autoDetect("Not There", state.dataPath)).toThrow(/Not There/);
  });
});
