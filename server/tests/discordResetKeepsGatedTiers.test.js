import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-05, D1: POST /discord/reset needs only
// integrations.manage, but it put every command tier back to its default.
// PUT /discord/permissions refuses to change a tier unless the caller holds
// that command's capability, so a role holding integrations.manage without
// players.moderate couldn't lower a raised /kick there -- but it could wipe
// the setup, and once someone entered a token again /kick was back at
// "moderator" and mod-role holders could kick players. Nobody chose that.
//
// Fix: the reset keeps every tier the caller couldn't change through PUT
// /permissions and resets only the rest.
//
// Drives the real route against the real DiscordBot; only the settings
// store, the secret file, the discord.js Client and fetch are faked.

const { settings, secrets } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
}));

const EVERY_COMMAND_CAPABILITY = [
  "players.view",
  "server.control",
  "server.world_events",
  "players.moderate",
  "rcon.execute",
];

const ROLES = {
  integrations_only: { capabilities: ["integrations.manage"] },
  integrations_and_moderate: {
    capabilities: ["integrations.manage", "players.moderate"],
  },
  admin: { capabilities: ["integrations.manage", ...EVERY_COMMAND_CAPABILITY] },
};

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
  getRoleByName: vi.fn(async (name) => ROLES[name] || null),
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
const { default: router } = await import("../routes/discord.js");

const GUILD = "100000000000000001";
const ADMIN_ROLE = "200000000000000001";
const MOD_ROLE = "300000000000000001";
const CHANNEL = "400000000000000001";

const DEFAULT_TIERS = {
  status: "everyone",
  players: "everyone",
  save: "moderator",
  broadcast: "moderator",
  kick: "moderator",
  start: "admin",
  stop: "admin",
  restart: "admin",
  rcon: "admin",
};

// An admin raised every command that isn't already at "admin", and lowered
// /rcon to the moderator tier.
const ADMIN_TIERS = {
  status: "admin",
  players: "admin",
  save: "admin",
  broadcast: "admin",
  kick: "admin",
  start: "admin",
  stop: "admin",
  restart: "admin",
  rcon: "moderator",
};

function seedConfiguredBot() {
  settings.clear();
  secrets.clear();
  secrets.set("discordBotToken", "operators-bot-token");
  settings.set("discordGuildId", GUILD);
  settings.set("discordAdminRoleId", ADMIN_ROLE);
  settings.set("discordModRoleId", MOD_ROLE);
  settings.set("discordChannelId", CHANNEL);
  settings.set("discordCommandPermissions", JSON.stringify(ADMIN_TIERS));
}

async function makeBot() {
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  await bot.loadConfig();
  return bot;
}

async function run(bot, method, path, body, role) {
  const useLayer = router.stack.find(
    (entry) => !entry.route && typeof entry.handle === "function",
  );
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
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

function interactionFrom(roleIds) {
  return {
    user: { id: "500000000000000001" },
    guild: { ownerId: "500000000000000999" },
    member: { roles: roleIds },
  };
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("POST /discord/reset keeps the tiers the caller couldn't change", () => {
  beforeEach(() => {
    seedConfiguredBot();
  });

  it("integrations.manage alone resets only /status and keeps every other tier", async () => {
    const bot = await makeBot();

    const response = await run(bot, "post", "/reset", {}, "integrations_only");

    expect(response.status).not.toHaveBeenCalled();
    const expected = { ...ADMIN_TIERS, status: "everyone" };
    expect(bot.getCommandPermissions()).toEqual(expected);
    expect(JSON.parse(settings.get("discordCommandPermissions"))).toEqual(expected);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        keptCommandPermissions: ["players", "save", "broadcast", "kick", "rcon"],
      }),
    );
    // The rest of the wipe still happens.
    expect(secrets.get("discordBotToken")).toBe("");
    expect(settings.get("discordGuildId")).toBe("");
    expect(settings.get("discordAdminRoleId")).toBe("");
    expect(settings.get("discordModRoleId")).toBe("");
    expect(bot.token).toBeNull();
  });

  it("a raised /kick is still raised after an admin sets the bot up again", async () => {
    const bot = await makeBot();
    await run(bot, "post", "/reset", {}, "integrations_only");

    const config = await run(
      bot,
      "put",
      "/config",
      {
        token: "new-bot-token",
        guildId: GUILD,
        adminRoleId: ADMIN_ROLE,
        modRoleId: MOD_ROLE,
        channelId: CHANNEL,
      },
      "admin",
    );
    expect(config.status).not.toHaveBeenCalledWith(403);

    for (const command of ["save", "broadcast", "kick"]) {
      expect(bot.checkPermission(interactionFrom([MOD_ROLE]), command)).toBe(false);
    }
  });

  it("resets the tiers whose capability the caller holds", async () => {
    const bot = await makeBot();

    const response = await run(bot, "post", "/reset", {}, "integrations_and_moderate");

    expect(bot.getCommandPermissions()).toEqual({
      ...ADMIN_TIERS,
      status: "everyone",
      kick: "moderator",
    });
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        keptCommandPermissions: ["players", "save", "broadcast", "rcon"],
      }),
    );
  });

  it("a caller holding every command capability still gets every default back", async () => {
    const bot = await makeBot();

    const response = await run(bot, "post", "/reset", {}, "admin");

    expect(bot.getCommandPermissions()).toEqual(DEFAULT_TIERS);
    expect(JSON.parse(settings.get("discordCommandPermissions"))).toEqual(DEFAULT_TIERS);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, keptCommandPermissions: [] }),
    );
  });

  it("DiscordBot.resetConfig() changes no tier unless told which ones to reset", async () => {
    const bot = await makeBot();

    const kept = await bot.resetConfig();

    expect(bot.getCommandPermissions()).toEqual(ADMIN_TIERS);
    expect(kept).toEqual(Object.keys(ADMIN_TIERS).filter((c) => ADMIN_TIERS[c] !== DEFAULT_TIERS[c]));
  });
});
