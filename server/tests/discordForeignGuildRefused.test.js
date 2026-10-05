import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-05, D2: moving the bot to another guild needs
// every bot command's capability (PUT /discord/config), because
// checkPermission() lets the guild's owner and its Administrators run every
// command. But the bot answered a slash command from ANY guild. Commands
// registered in a previous guild stay there when the move happened while
// the bot was stopped (updateConfig() only cleans up the old guild while
// running) or the cleanup failed, and the bot stays a member there -- so
// the previous guild's owner could still run /rcon, /stop and the rest
// after the panel had moved the bot away.
//
// Fix: handleInteraction() refuses any interaction that doesn't come from
// the configured guild.

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
}));

vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: vi.fn(async (name) => secrets.get(name) || null),
  writeUiSecretFile: vi.fn((name, value) => {
    secrets.set(name, value);
  }),
}));

// resetConfig() asks Discord for the bot's application id to clear its
// slash commands; answer "invalid token" so the test never leaves the box.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
);

const { DiscordBot } = await import("../services/discordBot.js");

afterAll(() => {
  vi.unstubAllGlobals();
});

const GUILD = "100000000000000001";
const PREVIOUS_GUILD = "100000000000000002";
const OWNER = "500000000000000001";

async function makeBot() {
  settings.clear();
  secrets.clear();
  secrets.set("discordBotToken", "operators-bot-token");
  settings.set("discordGuildId", GUILD);
  settings.set("discordAdminRoleId", "200000000000000001");
  settings.set("discordModRoleId", "");
  settings.set("discordChannelId", "400000000000000001");
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  await bot.loadConfig();
  vi.spyOn(bot, "handleRcon").mockResolvedValue(undefined);
  vi.spyOn(bot, "handleStatus").mockResolvedValue(undefined);
  return bot;
}

// The owner of `guildId` runs `/commandName` there.
function ownerInteraction(guildId, commandName) {
  return {
    isChatInputCommand: () => true,
    commandName,
    guildId,
    guild: { id: guildId, ownerId: OWNER },
    user: { id: OWNER, tag: "owner" },
    member: { roles: [] },
    reply: vi.fn(async () => {}),
  };
}

describe("the bot answers slash commands only in its configured guild", () => {
  let bot;
  beforeEach(async () => {
    bot = await makeBot();
  });

  it("refuses /rcon from the owner of a previous guild", async () => {
    const interaction = ownerInteraction(PREVIOUS_GUILD, "rcon");

    await bot.handleInteraction(interaction);

    expect(bot.handleRcon).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("isn't set up for this server") }),
    );
  });

  it("refuses even an everyone-tier command there", async () => {
    await bot.handleInteraction(ownerInteraction(PREVIOUS_GUILD, "status"));

    expect(bot.handleStatus).not.toHaveBeenCalled();
  });

  it("refuses everything once the setup is wiped", async () => {
    await bot.resetConfig();

    await bot.handleInteraction(ownerInteraction(GUILD, "status"));

    expect(bot.handleStatus).not.toHaveBeenCalled();
  });

  it("still answers in the configured guild", async () => {
    await bot.handleInteraction(ownerInteraction(GUILD, "rcon"));

    expect(bot.handleRcon).toHaveBeenCalledTimes(1);
  });
});
