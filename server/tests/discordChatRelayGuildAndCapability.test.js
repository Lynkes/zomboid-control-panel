import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-05, HT4b: the Discord-to-game chat relay posts
// what people type in its channel into the game as "[Discord] name: text"
// through RCON servermsg -- what the panel's own POST /server/message
// gates behind server.world_events. Two gaps:
//   1. It matched the channel ID alone, with no guild check, so a channel
//      the bot can see in another guild (one it was moved away from, say)
//      relayed into the game. It now relays only from the configured guild,
//      as slash commands already answer only there (D2).
//   2. PUT /discord/config let integrations.manage alone turn the relay on
//      or point it at another channel (the relay channel, or the
//      notification channel while none is set). That now needs
//      server.world_events as well (technician and admin hold both).
// HT4c: a wipe puts auto-start and the relay back to what a fresh install
// reads -- both on -- which the wipe dialog now says; pinned at the end.
//
// Drives the real DiscordBot and routes; only the settings store, the
// secret file, discord.js's Client (helpers/fakeDiscordClient.js) and
// fetch are faked.

const { settings, secrets } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
}));

const ROLES = {
  integrations_only: { capabilities: ["integrations.manage"] },
  integrations_and_world_events: { capabilities: ["integrations.manage", "server.world_events"] },
};

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  const { FakeDiscordClient } = await import("./helpers/fakeDiscordClient.js");
  return { ...actual, Client: FakeDiscordClient };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => (settings.has(key) ? settings.get(key) : null)),
  setSetting: vi.fn(async (key, value) => {
    settings.set(key, value);
  }),
  getRoleByName: vi.fn(async (name) => ROLES[name] || null),
}));

vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: vi.fn(async (name) => secrets.get(name) || null),
  writeUiSecretFile: vi.fn((name, value) => {
    secrets.set(name, value);
  }),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
);

const { DiscordBot } = await import("../services/discordBot.js");
const { default: router } = await import("../routes/discord.js");
const { fakeDiscordClients } = await import("./helpers/fakeDiscordClient.js");

const GUILD = "100000000000000001";
const OTHER_GUILD = "100000000000000099";
const ADMIN_ROLE = "200000000000000001";
const CHANNEL = "400000000000000001";
const OTHER_CHANNEL = "400000000000000002";
const RELAY_CHANNEL = "400000000000000003";

function seedConfiguredBot(extra = {}) {
  settings.clear();
  secrets.clear();
  secrets.set("discordBotToken", "operators-bot-token");
  settings.set("discordGuildId", GUILD);
  settings.set("discordAdminRoleId", ADMIN_ROLE);
  settings.set("discordModRoleId", "");
  settings.set("discordChannelId", CHANNEL);
  for (const [key, value] of Object.entries(extra)) settings.set(key, value);
}

function makeBot(rconService = { connected: false }) {
  const bot = new DiscordBot(rconService, {}, { on: vi.fn() }, null);
  bot.registerCommands = vi.fn(async () => {});
  bot._startPresenceUpdates = vi.fn();
  return bot;
}

async function putConfig(bot, body, role) {
  const useLayer = router.stack.find((entry) => !entry.route && typeof entry.handle === "function");
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === "/config" && entry.route.methods.put,
  );
  const handlers = [useLayer.handle, ...routeLayer.route.stack.map((s) => s.handle)];
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { user: { role }, app: { get: () => bot }, body };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

// What the settings page sends on every save (Discord.tsx handleSaveConfig).
function resendBody(overrides = {}) {
  return {
    token: "KEEP_EXISTING",
    guildId: GUILD,
    adminRoleId: ADMIN_ROLE,
    modRoleId: undefined,
    channelId: CHANNEL,
    autoStart: true,
    chatRelayEnabled: true,
    chatRelayScope: "public",
    ...overrides,
  };
}

function discordMessage({ guildId, channelId = CHANNEL, content = "hello from discord" }) {
  return {
    author: { bot: false, username: "Mallory", id: "500000000000000001" },
    system: false,
    guildId,
    channelId,
    content,
    mentions: { users: new Map(), roles: new Map(), channels: new Map() },
    reply: vi.fn(async () => {}),
  };
}

afterEach(async () => {
  fakeDiscordClients.length = 0;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Discord-to-game relay: only from the configured guild", () => {
  let bot;
  let rconService;

  beforeEach(async () => {
    seedConfiguredBot();
    rconService = { connected: true, serverMessage: vi.fn(async () => ({ success: true })) };
    bot = makeBot(rconService);
    expect(await bot.start()).toBe(true);
  });

  afterEach(async () => {
    await bot.stop();
  });

  const relay = (message) => fakeDiscordClients.at(-1).listeners.get("messageCreate")(message);

  it("a message in the relay channel of another guild is not posted in game", async () => {
    await relay(discordMessage({ guildId: OTHER_GUILD }));

    expect(rconService.serverMessage).not.toHaveBeenCalled();
  });

  it("nor one with no guild (a direct message)", async () => {
    await relay(discordMessage({ guildId: null }));

    expect(rconService.serverMessage).not.toHaveBeenCalled();
  });

  it("legit: a message in the relay channel of the configured guild still is", async () => {
    await relay(discordMessage({ guildId: GUILD }));

    expect(rconService.serverMessage).toHaveBeenCalledWith("[Discord] Mallory: hello from discord");
  });
});

describe("PUT /discord/config: the relay's channel and switch need server.world_events", () => {
  function expectRelayRefused(response) {
    expect(response.status).toHaveBeenCalledWith(403);
    const payload = response.json.mock.calls[0][0];
    expect(payload.code).toBe("DISCORD_CHAT_RELAY_CAPABILITY_REQUIRED");
    expect(payload.params).toEqual({ detail: "server.world_events" });
    expect(payload.missing).toEqual(["server.world_events"]);
  }

  function expectSaved(response) {
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  }

  it("integrations.manage alone can't point the relay at a channel of its choosing", async () => {
    seedConfiguredBot();
    const bot = makeBot();
    await bot.loadConfig();

    const response = await putConfig(bot, resendBody({ chatRelayChannelId: OTHER_CHANNEL }), "integrations_only");

    expectRelayRefused(response);
    expect(settings.has("discordChatRelayChannelId")).toBe(false);
    expect(bot.chatRelayChannelId).toBeNull();
  });

  it("nor move the notification channel the relay listens in while no relay channel is set", async () => {
    seedConfiguredBot();
    const bot = makeBot();
    await bot.loadConfig();

    const response = await putConfig(bot, resendBody({ channelId: OTHER_CHANNEL }), "integrations_only");

    expectRelayRefused(response);
    expect(settings.get("discordChannelId")).toBe(CHANNEL);
  });

  it("nor turn the relay on", async () => {
    seedConfiguredBot({ discordChatRelayEnabled: false });
    const bot = makeBot();
    await bot.loadConfig();

    const response = await putConfig(bot, resendBody({ chatRelayEnabled: true }), "integrations_only");

    expectRelayRefused(response);
    expect(settings.get("discordChatRelayEnabled")).toBe(false);
    expect(bot.chatRelayEnabled).toBe(false);
  });

  it("a role holding server.world_events may do all three", async () => {
    seedConfiguredBot({ discordChatRelayEnabled: false });
    const bot = makeBot();
    await bot.loadConfig();

    const response = await putConfig(
      bot,
      resendBody({ channelId: OTHER_CHANNEL, chatRelayEnabled: true, chatRelayChannelId: RELAY_CHANNEL }),
      "integrations_and_world_events",
    );

    expectSaved(response);
    expect(settings.get("discordChatRelayEnabled")).toBe(true);
    expect(settings.get("discordChatRelayChannelId")).toBe(RELAY_CHANNEL);
    expect(settings.get("discordChannelId")).toBe(OTHER_CHANNEL);
  });

  it("legit with integrations.manage alone: an unchanged resend, turning the relay off, and anything while it is off", async () => {
    seedConfiguredBot();
    const bot = makeBot();
    await bot.loadConfig();

    expectSaved(await putConfig(bot, resendBody(), "integrations_only"));

    expectSaved(
      await putConfig(
        bot,
        resendBody({ chatRelayEnabled: false, channelId: OTHER_CHANNEL, chatRelayChannelId: RELAY_CHANNEL }),
        "integrations_only",
      ),
    );
    expect(settings.get("discordChatRelayEnabled")).toBe(false);
    expect(settings.get("discordChannelId")).toBe(OTHER_CHANNEL);
    expect(settings.get("discordChatRelayChannelId")).toBe(RELAY_CHANNEL);
  });

  it("legit with integrations.manage alone: the notification channel moves freely once the relay has its own", async () => {
    seedConfiguredBot({ discordChatRelayChannelId: RELAY_CHANNEL });
    const bot = makeBot();
    await bot.loadConfig();

    const response = await putConfig(bot, resendBody({ channelId: OTHER_CHANNEL }), "integrations_only");

    expectSaved(response);
    expect(settings.get("discordChannelId")).toBe(OTHER_CHANNEL);
  });
});

describe("HT4c: a wipe puts auto-start and the relay back to a fresh install's defaults", () => {
  it("both on, the relay in the notification channel with public chat -- and with no token, nothing runs", async () => {
    seedConfiguredBot({
      discordAutoStart: false,
      discordChatRelayEnabled: false,
      discordChatRelayChannelId: RELAY_CHANNEL,
      discordChatRelayScope: "general",
    });
    const bot = makeBot();
    await bot.loadConfig();
    const resetLayer = router.stack.find((entry) => entry.route?.path === "/reset");
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    await resetLayer.route.stack.at(-1).handle(
      { user: { role: "integrations_only" }, app: { get: () => bot }, body: {} },
      response,
    );
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // What GET /config shows afterwards is what it shows on a fresh install.
    const configLayer = router.stack.find((entry) => entry.route?.path === "/config" && entry.route.methods.get);
    const read = async () => {
      const res = { status: vi.fn(), json: vi.fn() };
      await configLayer.route.stack.at(-1).handle({ app: { get: () => bot } }, res);
      return res.json.mock.calls[0][0];
    };
    const afterWipe = await read();
    settings.clear();
    secrets.clear();
    const fresh = await read();
    for (const key of ["autoStart", "chatRelayEnabled", "chatRelayChannelId", "chatRelayScope", "hasToken"]) {
      expect(afterWipe[key], key).toEqual(fresh[key]);
    }
    // Stored as "" by the wipe, unset on a fresh install: no channel either way.
    expect(afterWipe.channelId || null).toBeNull();
    expect(afterWipe).toMatchObject({ autoStart: true, chatRelayEnabled: true, chatRelayScope: "public", hasToken: false });
    expect(await bot.start()).toBe(false);
  });
});
