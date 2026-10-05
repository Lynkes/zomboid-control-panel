import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-04, FILES-2 adversary pass 2: the settings copy of
// serverConfigPath is the folder Server Files falls back to when the active
// server has no folders of its own, and PUT /config/app-settings saved it
// unchecked. A custom role holding panel.settings + servers.manage (no
// files.manage) could point Server Files at any folder on this computer
// through it. It now follows the same rule as a server's own config folder
// (utils/serverConfigPath.js): inside <zomboidDataPath>/Server.

const ROLES = {
  settings_and_servers: { capabilities: ["panel.settings", "servers.manage"] },
};

const stored = {};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);
const getAllSettings = vi.fn(async () => ({ ...stored }));
const getSetting = vi.fn(async (key) => stored[key] ?? null);
const setSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  getSetting,
  setSetting,
  getRoleByName,
}));

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials: vi.fn(),
}));

const { default: router } = await import("../routes/config.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-settings-config-path-"));
const dataDir = path.join(root, "Zomboid");
const configDir = path.join(dataDir, "Server");
const outsideDir = path.join(root, "unrelated-host-dir");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function putAppSettings(settings) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = {
    body: { settings },
    user: { role: "settings_and_servers" },
    app: { get: () => null },
  };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

describe("PUT /config/app-settings -- serverConfigPath is confined like a server's own", () => {
  beforeEach(() => {
    for (const key of Object.keys(stored)) delete stored[key];
    stored.zomboidDataPath = dataDir;
    stored.serverConfigPath = configDir;
    setSetting.mockReset();
  });

  it("refuses a config folder outside the data folder's Server folder", async () => {
    const response = await putAppSettings({ serverConfigPath: outsideDir });
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.SERVER_CONFIG_PATH_OUTSIDE_DATA }),
    );
    expect(setSetting).not.toHaveBeenCalledWith("serverConfigPath", expect.anything());
  });

  it("judges it against a data folder sent in the same save, and refuses one with no data folder", async () => {
    const moved = await putAppSettings({
      zomboidDataPath: outsideDir,
      serverConfigPath: configDir.replace(dataDir, outsideDir),
    });
    expect(moved.status).not.toHaveBeenCalledWith(400);

    for (const key of Object.keys(stored)) delete stored[key];
    const unanchored = await putAppSettings({ serverConfigPath: configDir });
    expect(unanchored.status).toHaveBeenCalledWith(400);
  });

  it("accepts the Server folder, and lets an unchanged value through (Settings sends its whole form)", async () => {
    stored.serverConfigPath = outsideDir; // saved before this check
    const unchanged = await putAppSettings({ serverConfigPath: outsideDir, darkMode: true });
    expect(unchanged.status).not.toHaveBeenCalledWith(400);
    expect(setSetting).toHaveBeenCalledWith("darkMode", true);

    const fixed = await putAppSettings({ serverConfigPath: configDir });
    expect(fixed.status).not.toHaveBeenCalledWith(400);
    expect(setSetting).toHaveBeenCalledWith("serverConfigPath", configDir);
  });
});
