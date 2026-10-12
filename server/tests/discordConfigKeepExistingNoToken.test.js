import { beforeEach, describe, expect, it, vi } from "vitest";

// The settings page sends token: "KEEP_EXISTING" on every save that leaves the
// token field alone. With no token saved there is nothing to keep, but the
// route used the marker itself as the token: it passed the "token required"
// check, was written to the secret file, and the bot then tried to log in with
// the text "KEEP_EXISTING". It is a 400 now, and nothing is written.

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

const GUILD = "100000000000000001";
const CHANNEL = "400000000000000001";

async function makeBot() {
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  bot.start = vi.fn(async () => {});
  await bot.loadConfig();
  return bot;
}

async function putConfig(bot, body) {
  const useLayer = router.stack.find((entry) => !entry.route && typeof entry.handle === "function");
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === "/config" && entry.route.methods.put,
  );
  const handlers = [useLayer.handle, ...routeLayer.route.stack.map((s) => s.handle)];
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { user: { role: "admin" }, app: { get: () => bot }, body };
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

describe("PUT /api/discord/config with the KEEP_EXISTING placeholder", () => {
  it("is refused when no token is saved, and the placeholder is never stored", async () => {
    const bot = await makeBot();

    const response = await putConfig(bot, {
      token: "KEEP_EXISTING",
      guildId: GUILD,
      channelId: CHANNEL,
      autoStart: true,
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("DISCORD_TOKEN_AND_GUILD_REQUIRED");
    expect(secrets.get("discordBotToken")).toBeUndefined();
    expect(settings.has("discordGuildId")).toBe(false);
    expect(bot.token).toBeFalsy();
    expect(bot.start).not.toHaveBeenCalled();
  });

  it("keeps the saved token when there is one", async () => {
    secrets.set("discordBotToken", "operators-bot-token");
    const bot = await makeBot();

    const response = await putConfig(bot, {
      token: "KEEP_EXISTING",
      guildId: GUILD,
      channelId: CHANNEL,
      autoStart: true,
    });

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(secrets.get("discordBotToken")).toBe("operators-bot-token");
  });

  it("still saves a real token typed into a fresh setup", async () => {
    const bot = await makeBot();

    const response = await putConfig(bot, {
      token: "a-real-token",
      guildId: GUILD,
      channelId: CHANNEL,
      autoStart: true,
    });

    expect(response.status).not.toHaveBeenCalled();
    expect(secrets.get("discordBotToken")).toBe("a-real-token");
  });
});
