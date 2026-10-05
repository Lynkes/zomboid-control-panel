import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-05, final round:
//   M1. The settings page sent `chatRelayChannelId || undefined`, and PUT
//       /discord/config keeps a relay channel it isn't sent, so emptying the
//       field never cleared it. The page now sends "", and the route takes
//       "" or null as "clear it" -- under the same server.world_events gate
//       (HT4b) as setting one, since the relay then listens in the
//       notification channel instead.
//   M2. The game-to-Discord direction had no guild check: game chat (to the
//       relay channel, or the notification channel while none is set) and
//       every notification went to whatever channel ID was saved, one in
//       another guild the bot is a member of included. _sendToChannel() now
//       sends only in a channel of the configured guild, as the Discord-to-
//       game relay reads (HT4b) and slash commands answer (D2) only there,
//       and warns when it refuses. POST /test-message says why.
//
// Drives the real DiscordBot and routes; only the settings store, the
// secret file, discord.js's Client (helpers/fakeDiscordClient.js, plus a
// channel map attached per test), fetch and the bot's logger are faked.

const { settings, secrets, loggers } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
  loggers: new Map(),
}));

const ALL_COMMAND_CAPS = [
  "integrations.manage",
  "players.view",
  "server.control",
  "server.world_events",
  "players.moderate",
  "rcon.execute",
];
const ROLES = {
  integrations_only: { capabilities: ["integrations.manage"] },
  integrations_and_world_events: { capabilities: ["integrations.manage", "server.world_events"] },
  owner: { capabilities: ALL_COMMAND_CAPS },
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

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createLogger: (source) => {
      if (!loggers.has(source)) {
        loggers.set(source, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
      }
      return loggers.get(source);
    },
  };
});

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
const DM_CHANNEL = "400000000000000004";

const discordLog = () => loggers.get("Discord");

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

async function route(method, routePath, bot, role, body = {}) {
  const useLayer = router.stack.find((entry) => !entry.route && typeof entry.handle === "function");
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
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

function expectSaved(response) {
  expect(response.status).not.toHaveBeenCalled();
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
}

function expectRelayRefused(response) {
  expect(response.status).toHaveBeenCalledWith(403);
  expect(response.json.mock.calls[0][0].code).toBe("DISCORD_CHAT_RELAY_CAPABILITY_REQUIRED");
}

async function readConfig(bot) {
  const response = await route("get", "/config", bot, "owner");
  return response.json.mock.calls[0][0];
}

// Channels as discord.js hands them back: a guild channel (or thread)
// carries its guild's ID, a direct-message channel none.
function textChannel(guildId) {
  return { guildId, isTextBased: () => true, send: vi.fn(async () => ({})) };
}

function attachChannels(client, channels) {
  client.channels = {
    fetch: vi.fn(async (id) => {
      if (!channels[id]) throw Object.assign(new Error("Unknown Channel"), { status: 404 });
      return channels[id];
    }),
  };
  return channels;
}

const warnings = () => discordLog().warn.mock.calls.map(([line]) => String(line));

afterEach(() => {
  fakeDiscordClients.length = 0;
  for (const logger of loggers.values()) {
    for (const fn of Object.values(logger)) fn.mockClear();
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("M1: PUT /discord/config clears the relay channel", () => {
  for (const cleared of ["", null]) {
    it(`${JSON.stringify(cleared)} clears it for a role holding server.world_events, and the relay then listens in the notification channel`, async () => {
      seedConfiguredBot({ discordChatRelayChannelId: RELAY_CHANNEL });
      const bot = makeBot();
      await bot.loadConfig();

      expectSaved(
        await route("put", "/config", bot, "integrations_and_world_events", resendBody({ chatRelayChannelId: cleared })),
      );

      expect(settings.get("discordChatRelayChannelId")).toBe("");
      expect(bot.chatRelayChannelId).toBeNull();
      expect((await readConfig(bot)).chatRelayChannelId).toBe("");
      // It survives a restart of the panel.
      const reloaded = makeBot();
      await reloaded.loadConfig();
      expect(reloaded.chatRelayChannelId || reloaded.channelId).toBe(CHANNEL);
    });

    it(`${JSON.stringify(cleared)} needs server.world_events when the relay would move to another channel`, async () => {
      seedConfiguredBot({ discordChatRelayChannelId: RELAY_CHANNEL });
      const bot = makeBot();
      await bot.loadConfig();

      expectRelayRefused(
        await route("put", "/config", bot, "integrations_only", resendBody({ chatRelayChannelId: cleared })),
      );

      expect(settings.get("discordChatRelayChannelId")).toBe(RELAY_CHANNEL);
      expect(bot.chatRelayChannelId).toBe(RELAY_CHANNEL);
    });
  }

  it("legit with integrations.manage alone: clearing it while the relay is off, or when it was the notification channel anyway", async () => {
    seedConfiguredBot({ discordChatRelayEnabled: false, discordChatRelayChannelId: RELAY_CHANNEL });
    const off = makeBot();
    await off.loadConfig();
    expectSaved(
      await route("put", "/config", off, "integrations_only", resendBody({ chatRelayEnabled: false, chatRelayChannelId: "" })),
    );
    expect(settings.get("discordChatRelayChannelId")).toBe("");

    seedConfiguredBot({ discordChatRelayChannelId: CHANNEL });
    const same = makeBot();
    await same.loadConfig();
    expectSaved(await route("put", "/config", same, "integrations_only", resendBody({ chatRelayChannelId: null })));
    expect(settings.get("discordChatRelayChannelId")).toBe("");
  });

  it("legit: a body that leaves it out keeps it, and 1.4.5 data reads as before", async () => {
    seedConfiguredBot({ discordChatRelayChannelId: RELAY_CHANNEL });
    const bot = makeBot();
    await bot.loadConfig();

    expectSaved(await route("put", "/config", bot, "integrations_only", resendBody()));

    expect(settings.get("discordChatRelayChannelId")).toBe(RELAY_CHANNEL);
    expect((await readConfig(bot)).chatRelayChannelId).toBe(RELAY_CHANNEL);
  });
});

describe("M2: the bot posts only in a channel of the configured guild", () => {
  let bot;

  async function startBot(extra = {}) {
    seedConfiguredBot(extra);
    bot = makeBot();
    expect(await bot.start()).toBe(true);
    return fakeDiscordClients.at(-1);
  }

  beforeEach(() => {
    bot = null;
  });

  afterEach(async () => {
    if (bot) await bot.stop();
  });

  const chatLine = (message = "anyone around?") => ({ type: "general", author: "Bob", message });

  it("game chat isn't relayed to a relay channel in another guild, and the refusal is logged once, not per chat line", async () => {
    const client = await startBot({ discordChatRelayChannelId: RELAY_CHANNEL });
    const channels = attachChannels(client, {
      [CHANNEL]: textChannel(GUILD),
      [RELAY_CHANNEL]: textChannel(OTHER_GUILD),
    });

    await bot.handleGameChat(chatLine());
    await bot.handleGameChat(chatLine("second line"));

    expect(channels[RELAY_CHANNEL].send).not.toHaveBeenCalled();
    expect(channels[CHANNEL].send).not.toHaveBeenCalled();
    const refusals = warnings().filter((line) => line.includes(RELAY_CHANNEL));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("game chat relay");
    expect(refusals[0]).toContain(`Discord server ${OTHER_GUILD}`);
    expect(refusals[0]).toContain(`Guild ID ${GUILD}`);
    // Not a delivery failure: the breaker doesn't count it.
    expect(bot._breakerFor(RELAY_CHANNEL).failures).toBe(0);
  });

  it("the warning comes back every ten minutes while the channel stays refused, with the count of sends refused meanwhile", async () => {
    const client = await startBot({ discordChatRelayChannelId: RELAY_CHANNEL });
    attachChannels(client, { [CHANNEL]: textChannel(GUILD), [RELAY_CHANNEL]: textChannel(OTHER_GUILD) });
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      await bot.handleGameChat(chatLine("one"));
      await bot.handleGameChat(chatLine("two"));
      await bot.handleGameChat(chatLine("three"));
      now.mockReturnValue(start + 10 * 60 * 1000);
      await bot.handleGameChat(chatLine("four"));
    } finally {
      now.mockRestore();
    }

    const refusals = warnings().filter((line) => line.includes(RELAY_CHANNEL));
    expect(refusals).toHaveLength(2);
    expect(refusals[1]).toContain("2 other send(s) to it were refused since the last warning");
  });

  it("nor to the notification channel it falls back to, when that one is in another guild", async () => {
    const client = await startBot({ discordChannelId: OTHER_CHANNEL });
    const channels = attachChannels(client, { [OTHER_CHANNEL]: textChannel(OTHER_GUILD) });

    await bot.handleGameChat(chatLine());

    expect(channels[OTHER_CHANNEL].send).not.toHaveBeenCalled();
    expect(warnings().some((line) => line.includes(OTHER_CHANNEL))).toBe(true);
  });

  it("event notifications aren't posted there either, nor in a direct-message channel", async () => {
    const client = await startBot({
      discordChannelId: OTHER_CHANNEL,
      discordWebhookEvents: JSON.stringify({ playerJoin: { enabled: true, template: "{player} joined" } }),
    });
    const channels = attachChannels(client, {
      [OTHER_CHANNEL]: textChannel(OTHER_GUILD),
      [DM_CHANNEL]: textChannel(undefined),
    });

    await bot.sendEventNotification("playerJoin", { player: "Bob" });
    expect(channels[OTHER_CHANNEL].send).not.toHaveBeenCalled();

    bot.channelId = DM_CHANNEL;
    expect(await bot.sendNotification("server restarting")).toBe(false);
    expect(channels[DM_CHANNEL].send).not.toHaveBeenCalled();
    expect(warnings().some((line) => line.includes(DM_CHANNEL) && line.includes("not in a Discord server"))).toBe(true);
  });

  it("POST /test-message says the channel is outside the configured server, rather than that Discord rejected it", async () => {
    const client = await startBot({ discordChannelId: OTHER_CHANNEL });
    const channels = attachChannels(client, { [OTHER_CHANNEL]: textChannel(OTHER_GUILD) });

    const response = await route("post", "/test-message", bot, "integrations_only");

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].code).toBe("DISCORD_CHANNEL_OUTSIDE_GUILD");
    expect(channels[OTHER_CHANNEL].send).not.toHaveBeenCalled();
  });

  it("legit: chat, notifications and the test message still go to channels of the configured guild (its ID compared as text)", async () => {
    const client = await startBot({
      discordChatRelayChannelId: RELAY_CHANNEL,
      discordWebhookEvents: JSON.stringify({ playerJoin: { enabled: true, template: "{player} joined" } }),
    });
    const channels = attachChannels(client, {
      [CHANNEL]: textChannel(GUILD),
      [RELAY_CHANNEL]: textChannel(GUILD),
    });

    await bot.handleGameChat(chatLine());
    await bot.sendEventNotification("playerJoin", { player: "Bob" });
    const response = await route("post", "/test-message", bot, "integrations_only");

    expect(channels[RELAY_CHANNEL].send).toHaveBeenCalledWith("**<Bob>** anyone around?");
    expect(channels[CHANNEL].send).toHaveBeenCalledWith("Bob joined");
    expect(channels[CHANNEL].send).toHaveBeenCalledWith(expect.stringContaining("Test message"));
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(discordLog().warn).not.toHaveBeenCalled();
  });

  it("legit: once the channel is one of the configured guild, the next send goes, and a later failure isn't blamed on the guild", async () => {
    const client = await startBot({ discordChannelId: OTHER_CHANNEL });
    const channels = attachChannels(client, { [OTHER_CHANNEL]: textChannel(OTHER_GUILD) });
    expect(await bot.sendNotification("first")).toBe(false);
    expect(bot.wasSendRefusedOutsideGuild(OTHER_CHANNEL)).toBe(true);

    channels[OTHER_CHANNEL].guildId = GUILD;
    expect(await bot.sendNotification("second")).toBe(true);
    expect(channels[OTHER_CHANNEL].send).toHaveBeenCalledWith("second");
    expect(bot.wasSendRefusedOutsideGuild(OTHER_CHANNEL)).toBe(false);

    channels[OTHER_CHANNEL].send.mockRejectedValueOnce(Object.assign(new Error("Missing Access"), { status: 403 }));
    const response = await route("post", "/test-message", bot, "integrations_only");
    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json.mock.calls[0][0].code).toBe("DISCORD_TEST_MESSAGE_REJECTED");
  });

  it("legit: the setup flow -- save a fresh setup, start the bot, send the test message", async () => {
    settings.clear();
    secrets.clear();
    bot = makeBot();

    expectSaved(
      await route("put", "/config", bot, "owner", {
        token: "new-bot-token",
        guildId: GUILD,
        channelId: CHANNEL,
        autoStart: true,
        chatRelayEnabled: true,
        chatRelayChannelId: "",
        chatRelayScope: "public",
      }),
    );
    expectSaved(await route("post", "/start", bot, "owner"));
    const channels = attachChannels(fakeDiscordClients.at(-1), { [CHANNEL]: textChannel(GUILD) });

    const response = await route("post", "/test-message", bot, "owner");

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(channels[CHANNEL].send).toHaveBeenCalledTimes(1);
  });
});
