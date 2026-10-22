import { beforeEach, describe, expect, it, vi } from "vitest";

// PUT /discord/permissions saves the tiers and then pushes the slash commands
// to Discord. The push was not guarded, so a Discord outage or rate limit
// after the tiers were already stored answered 500 -- "failed" for a save that
// had worked. The save now succeeds and carries commandsRegistered: false.

const { settings, secrets } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
}));

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, Client: class {} };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
  setSetting: vi.fn(async (key, value) => {
    settings.set(key, value);
  }),
  getRoleByName: vi.fn(async () => ({
    capabilities: [
      "integrations.manage",
      "players.view",
      "server.control",
      "server.world_events",
      "players.moderate",
      "rcon.execute",
    ],
  })),
}));

vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: vi.fn(async (name) => secrets.get(name) || null),
  writeUiSecretFile: vi.fn((name, value) => {
    secrets.set(name, value);
  }),
}));

const { DiscordBot } = await import("../services/discordBot.js");
const { default: router } = await import("../routes/discord.js");

function makeBot({ running = true, registerCommands } = {}) {
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  bot.isRunning = running;
  bot.client = { user: { id: "application" } };
  bot.registerCommands = registerCommands ?? vi.fn(async () => {});
  return bot;
}

async function putPermissions(bot, permissions) {
  const useLayer = router.stack.find((entry) => !entry.route && typeof entry.handle === "function");
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === "/permissions" && entry.route.methods.put,
  );
  const handlers = [useLayer.handle, ...routeLayer.route.stack.map((s) => s.handle)];
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { user: { role: "admin" }, app: { get: () => bot }, body: { permissions } };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

beforeEach(() => {
  settings.clear();
  secrets.clear();
});

describe("PUT /api/discord/permissions when pushing the commands to Discord fails", () => {
  it("still reports the save as a success, with the tiers stored and commandsRegistered: false", async () => {
    const bot = makeBot({
      registerCommands: vi.fn(async () => {
        throw new Error("Discord request timed out");
      }),
    });

    const response = await putPermissions(bot, { kick: "admin" });

    expect(response.status).not.toHaveBeenCalled();
    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ success: true, commandsRegistered: false });
    expect(body.permissions.kick).toBe("admin");
    expect(JSON.parse(settings.get("discordCommandPermissions")).kick).toBe("admin");
    expect(bot.getCommandPermissions().kick).toBe("admin");
  });

  it("says nothing extra when the commands were pushed", async () => {
    const bot = makeBot();

    const response = await putPermissions(bot, { kick: "admin" });

    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ success: true });
    expect(body).not.toHaveProperty("commandsRegistered");
    expect(bot.registerCommands).toHaveBeenCalledOnce();
  });

  it("says nothing extra when the bot is not running (nothing to push)", async () => {
    const bot = makeBot({ running: false });

    const response = await putPermissions(bot, { kick: "admin" });

    const body = response.json.mock.calls[0][0];
    expect(body).toMatchObject({ success: true });
    expect(body).not.toHaveProperty("commandsRegistered");
    expect(bot.registerCommands).not.toHaveBeenCalled();
  });
});
