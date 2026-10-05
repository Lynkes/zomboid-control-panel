import { beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-04, adversary pass on AUTHZ-3: PUT /discord/config
// now needs the capabilities of every bot command to move the bot to another
// guild (the bot registers its commands there and always obeys the guild's
// owner). PUT /config/app-settings still accepted discordGuildId with only
// integrations.manage on top of its own panel.settings gate, so a custom
// role holding those two -- but not rcon.execute or server.control -- could
// still move the bot to a guild it owns and run /rcon, /stop and /start.
//
// Fix: discordGuildId is no longer an app setting; /api/discord owns it.

const ROLES = {
  settings_and_integrations: {
    capabilities: ["panel.settings", "integrations.manage"],
  },
};

const getRoleByName = vi.fn(async (name) => ROLES[name] || null);
const getAllSettings = vi.fn();
const setSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  setSetting,
  getRoleByName,
}));

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials: vi.fn(),
}));

const { default: router } = await import("../routes/config.js");

async function putAppSettings(settings, role, current) {
  getAllSettings.mockResolvedValue(current);
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { body: { settings }, user: { role }, app: { get: () => null } };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

describe("PUT /config/app-settings no longer moves the Discord bot", () => {
  beforeEach(() => {
    getAllSettings.mockReset();
    setSetting.mockReset();
    getRoleByName.mockClear();
  });

  it("panel.settings + integrations.manage can't write discordGuildId here", async () => {
    await putAppSettings(
      { discordGuildId: "100000000000000099", darkMode: true },
      "settings_and_integrations",
      { discordGuildId: "100000000000000001", darkMode: false },
    );

    expect(setSetting).not.toHaveBeenCalledWith("discordGuildId", expect.anything());
    // The rest of the save still lands.
    expect(setSetting).toHaveBeenCalledWith("darkMode", true);
  });

  // Security sweep 2026-10-05, D2: the same holds for every other Discord
  // setting the bot's command checks read. /api/discord is the only door.
  it("no other Discord bot setting is writable here either", async () => {
    const discordSettings = {
      discordBotToken: "attackers-bot-token",
      discordAdminRoleId: "200000000000000099",
      discordModRoleId: "300000000000000099",
      discordChannelId: "400000000000000099",
      discordChatRelayChannelId: "400000000000000098",
      discordChatRelayEnabled: true,
      discordCommandPermissions: JSON.stringify({ rcon: "everyone" }),
    };

    await putAppSettings(
      { ...discordSettings, darkMode: true },
      "settings_and_integrations",
      { darkMode: false },
    );

    for (const key of Object.keys(discordSettings)) {
      expect(setSetting).not.toHaveBeenCalledWith(key, expect.anything());
    }
    expect(setSetting).toHaveBeenCalledWith("darkMode", true);
  });
});
