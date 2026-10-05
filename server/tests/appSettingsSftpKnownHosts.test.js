import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// The SFTP host-key pins (sftpKnownHosts, services/sftpHostKeys.js) live in
// the settings table but change only through "Trust new host key", which
// needs bridge.setup. The Settings page loads every app setting and sends
// the whole object back on Save, so the route must neither hand the pins
// out nor take a copy back: a page loaded before a trust would otherwise
// restore the old pin, or erase one made since.
const getAllSettings = vi.fn();
const setSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  setSetting,
  getSetting: vi.fn(async () => null),
  getRoleByName: mockGetRoleByName,
}));

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials: vi.fn(),
}));

const { default: router } = await import("../routes/config.js");
const { KNOWN_HOSTS_SETTING } = await import("../services/sftpHostKeys.js");

async function runRoute(method, req) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/app-settings" && entry.route.methods[method],
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

const PINS = JSON.stringify({ "pz.example.net:22": "a".repeat(64) });

describe("app-settings and the SFTP host-key pins", () => {
  it("GET leaves the pins out", async () => {
    getAllSettings.mockResolvedValue({ [KNOWN_HOSTS_SETTING]: PINS, darkMode: true });
    const res = await runRoute("get", { app: { get: () => null } });
    const { settings } = res.json.mock.calls[0][0];
    expect(settings).not.toHaveProperty(KNOWN_HOSTS_SETTING);
    expect(settings.darkMode).toBe(true);
  });

  it("PUT never writes them, even from an admin's full-object Save", async () => {
    getAllSettings.mockResolvedValue({ darkMode: false });
    setSetting.mockReset();
    await runRoute("put", {
      body: { settings: { [KNOWN_HOSTS_SETTING]: "{}", darkMode: true } },
      user: { role: "admin" },
      app: { get: () => null },
    });
    expect(setSetting).toHaveBeenCalledWith("darkMode", true);
    expect(setSetting).not.toHaveBeenCalledWith(KNOWN_HOSTS_SETTING, expect.anything());
  });
});
