// Shared fixtures for the PanelBridge delivery tests (bridgeDelivery*.test.js):
// real temp game folders and server.ini files, plus an in-memory stand-in for
// the servers table that each test file's vi.mock("../database/init.js")
// factory reads from (see createDbState / dbMockImplementation).
import fs from "fs";
import os from "os";
import path from "path";
import { resolveSourcePath } from "../../services/panelBridgeInstaller.js";

export const MOD = "ZCPB";
export const WS_ID = "3712345678";
export const DEFAULT_INI = "PVP=true\r\nMods=OtherMod\r\nWorkshopItems=111\r\nDoLuaChecksum=true\r\n";
export const CLIENT_COMPANION = "-- PanelBridge client companion for effects the server can't replicate\n";

export function bundledLua() {
  return fs.readFileSync(resolveSourcePath(), "utf8");
}

export function createRoot(prefix = "bridge-delivery-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// One profile's on-disk pieces: a game folder (shared when installDir is
// passed in) and a data folder holding Server/<serverName>.ini.
export function createServerFiles(root, { key = "s1", serverName = "servertest", ini = DEFAULT_INI, installDir } = {}) {
  const dir = installDir || path.join(root, `install-${key}`);
  const dataDir = path.join(root, `data-${key}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "Server"), { recursive: true });
  const iniPath = path.join(dataDir, "Server", `${serverName}.ini`);
  if (ini !== null) fs.writeFileSync(iniPath, ini);
  return { installDir: dir, dataDir, iniPath };
}

export function makeServer(files, overrides = {}) {
  return {
    id: "s1",
    name: "Server One",
    serverName: "servertest",
    installPath: files.installDir,
    zomboidDataPath: files.dataDir,
    isRemote: false,
    isActive: true,
    ...overrides,
  };
}

export function looseServerPath(installDir) {
  return path.join(installDir, "media", "lua", "server", "PanelBridge.lua");
}

export function writeLoose(installDir, relative, content) {
  const full = path.join(installDir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

export function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

// The servers table as the real database/init.js exposes it: getServers()
// hands out copies, updateServer() merges like the real spread.
export function dbMockImplementation(state) {
  const clone = (server) => (server ? JSON.parse(JSON.stringify(server)) : null);
  return {
    getServers: async () => state.servers.map(clone),
    getServer: async (id) => clone(state.servers.find((s) => String(s.id) === String(id)) || null),
    getActiveServer: async () => clone(state.servers.find((s) => s.isActive) || state.servers[0] || null),
    getSetting: async (key) => (key in state.settings ? state.settings[key] : null),
    updateServer: async (id, updates) => {
      // Injected failures are one-shot, like a transient disk error: the
      // rollback's own writes then go through.
      if (state.failUpdate) {
        state.failUpdate = false;
        throw new Error("db write failed");
      }
      const index = state.servers.findIndex((s) => String(s.id) === String(id));
      if (index === -1) return null;
      state.servers[index] = { ...state.servers[index], ...updates, id };
      for (const key of Object.keys(updates)) {
        if (updates[key] === undefined) delete state.servers[index][key];
      }
      return clone(state.servers[index]);
    },
    commitNow: async () => {
      if (state.failCommit) {
        state.failCommit = false;
        throw new Error("commit failed");
      }
      state.commits = (state.commits || 0) + 1;
    },
  };
}

// Snapshot of everything an apply may touch, for "left identical" checks.
export function snapshotFiles(paths) {
  const out = {};
  for (const p of paths) out[p] = fs.existsSync(p) ? fs.readFileSync(p).toString("base64") : null;
  return out;
}
