import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-05, HT4a: a stored command tier that is missing,
// empty or not a tier read two ways. checkPermission() and getCommands()
// took it as "admin" (`|| "admin"`), resetConfig() as the command's default
// (`|| defaultTier`). The D1 wipe rule keeps only a tier that differs from
// the default, so a wipe by integrations.manage alone turned an
// effectively admin-only /kick ("kick": "") into the moderator tier, and
// once the bot was set up again mod-role holders could kick players --
// which PUT /permissions refuses that caller.
//
// Fix: one reading, the stricter one. loadConfig() and
// updateCommandPermissions() store every tier normalized, and every reader
// goes through commandTierOf(): such a tier is "admin" everywhere.
//
// Drives the real routes against the real DiscordBot; only the settings
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

// resetConfig() asks Discord for the bot's application id; answer "invalid
// token" so the test never leaves the box.
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

function seedConfiguredBot(storedTiers) {
  settings.clear();
  secrets.clear();
  secrets.set("discordBotToken", "operators-bot-token");
  settings.set("discordGuildId", GUILD);
  settings.set("discordAdminRoleId", ADMIN_ROLE);
  settings.set("discordModRoleId", MOD_ROLE);
  settings.set("discordChannelId", CHANNEL);
  if (storedTiers !== undefined) settings.set("discordCommandPermissions", storedTiers);
}

async function makeBot() {
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  await bot.loadConfig();
  return bot;
}

async function run(bot, method, path, body, role) {
  const useLayer = router.stack.find((entry) => !entry.route && typeof entry.handle === "function");
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

afterAll(() => {
  vi.unstubAllGlobals();
});

// A member of the configured guild who is neither its owner nor a Discord
// Administrator, holding only the mod role.
const modRoleHolder = {
  user: { id: "500000000000000001" },
  guild: { ownerId: "500000000000000999" },
  member: { roles: [MOD_ROLE] },
};

// What a hand-edited or damaged db.json can hold: /kick empty, /save null,
// /broadcast missing, /players not a tier.
const DAMAGED_TIERS = JSON.stringify({
  status: "everyone",
  players: "superuser",
  save: null,
  kick: "",
  start: "admin",
  stop: "admin",
  restart: "admin",
  rcon: "admin",
});

describe("a stored tier that is missing, empty or not a tier reads as admin everywhere", () => {
  beforeEach(() => {
    seedConfiguredBot(DAMAGED_TIERS);
  });

  it("loadConfig() stores it as admin, and checkPermission() agrees", async () => {
    const bot = await makeBot();

    expect(bot.getCommandPermissions()).toEqual({
      ...DEFAULT_TIERS,
      players: "admin",
      save: "admin",
      broadcast: "admin",
      kick: "admin",
    });
    for (const command of ["players", "save", "broadcast", "kick"]) {
      expect(bot.checkPermission(modRoleHolder, command), command).toBe(false);
    }
    expect(bot.checkPermission(modRoleHolder, "status")).toBe(true);
  });

  it("a wipe by integrations.manage alone keeps them admin-only, after the bot is set up again too", async () => {
    const bot = await makeBot();

    const wiped = await run(bot, "post", "/reset", {}, "integrations_only");

    expect(wiped.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        keptCommandPermissions: ["players", "save", "broadcast", "kick"],
      }),
    );
    expect(JSON.parse(settings.get("discordCommandPermissions")).kick).toBe("admin");

    const setup = await run(
      bot,
      "put",
      "/config",
      { token: "new-bot-token", guildId: GUILD, adminRoleId: ADMIN_ROLE, modRoleId: MOD_ROLE, channelId: CHANNEL },
      "admin",
    );
    expect(setup.status).not.toHaveBeenCalled();
    for (const command of ["save", "broadcast", "kick"]) {
      expect(bot.checkPermission(modRoleHolder, command), command).toBe(false);
    }
  });

  it("GET /permissions shows the tier the bot enforces", async () => {
    const bot = await makeBot();

    const response = await run(bot, "get", "/permissions", undefined, "integrations_only");

    expect(response.json.mock.calls[0][0].permissions.kick).toBe("admin");
  });

  it("a stored value that can't be read makes every command admin-only", async () => {
    seedConfiguredBot("{not json");
    const bot = await makeBot();

    expect(Object.values(bot.getCommandPermissions())).toEqual(Array(9).fill("admin"));
  });
});

describe("legit: valid stored tiers and a fresh install read as before", () => {
  it("nothing stored: the defaults", async () => {
    seedConfiguredBot(undefined);
    const bot = await makeBot();

    expect(bot.getCommandPermissions()).toEqual(DEFAULT_TIERS);
    expect(bot.checkPermission(modRoleHolder, "kick")).toBe(true);
  });

  it("every tier stored, as 1.4.5 writes them: unchanged", async () => {
    const saved = { ...DEFAULT_TIERS, players: "moderator", rcon: "moderator" };
    seedConfiguredBot(JSON.stringify(saved));
    const bot = await makeBot();

    expect(bot.getCommandPermissions()).toEqual(saved);
    expect(bot.checkPermission(modRoleHolder, "rcon")).toBe(true);
  });

  it("a wipe by a caller holding every capability puts damaged tiers back to their defaults", async () => {
    seedConfiguredBot(DAMAGED_TIERS);
    const bot = await makeBot();

    await run(bot, "post", "/reset", {}, "admin");

    expect(bot.getCommandPermissions()).toEqual(DEFAULT_TIERS);
  });
});
