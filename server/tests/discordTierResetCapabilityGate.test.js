import { beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-04, adversary pass on AUTHZ-3: PUT /discord/config
// now refuses a mod-role change while commands sit at the moderator tier
// unless the caller holds their capabilities, but PUT /discord/permissions
// let the tiers be reset afterwards with no check. Its per-command check
// only looked at commands in the request body, and
// DiscordBot.updateCommandPermissions() merged the body onto the DEFAULT
// tiers, so a partial body (even `{}`) dropped /save, /broadcast and /kick
// back to "moderator" unchecked. A role holding only integrations.manage
// could set the mod role while those were raised to "admin" (allowed: it
// unlocked nothing), then send `{}` and run them from Discord.
//
// Fix: updateCommandPermissions() merges onto the current tiers, so only
// the commands the body names can change, and those are checked.
//
// Drives the real route against the real DiscordBot; only the settings
// store, the secret file and the discord.js Client are faked.

const { settings, secrets } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
}));

const ROLES = {
  integrations_only: { capabilities: ["integrations.manage"] },
  admin: {
    capabilities: [
      "integrations.manage",
      "players.view",
      "server.control",
      "server.world_events",
      "players.moderate",
      "rcon.execute",
    ],
  },
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

const { DiscordBot } = await import("../services/discordBot.js");
const { default: router } = await import("../routes/discord.js");

const GUILD = "100000000000000001";
const ADMIN_ROLE = "200000000000000001";
const ATTACKER_ROLE = "300000000000000001";
const CHANNEL = "400000000000000001";

// The operator raised every command that defaults to "moderator".
const RAISED_TIERS = {
  status: "everyone",
  players: "everyone",
  save: "admin",
  broadcast: "admin",
  kick: "admin",
  start: "admin",
  stop: "admin",
  restart: "admin",
  rcon: "admin",
};

function seedConfiguredBot() {
  settings.clear();
  secrets.clear();
  secrets.set("discordBotToken", "operators-bot-token");
  settings.set("discordGuildId", GUILD);
  settings.set("discordAdminRoleId", ADMIN_ROLE);
  settings.set("discordModRoleId", "");
  settings.set("discordChannelId", CHANNEL);
  settings.set("discordCommandPermissions", JSON.stringify(RAISED_TIERS));
}

async function makeBot() {
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  await bot.loadConfig();
  return bot;
}

async function run(bot, path, body, role) {
  const useLayer = router.stack.find(
    (entry) => !entry.route && typeof entry.handle === "function",
  );
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods.put,
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

describe("PUT /discord/permissions can't reset tiers it doesn't name", () => {
  beforeEach(() => {
    seedConfiguredBot();
  });

  it("an empty body leaves every raised tier where it is", async () => {
    const bot = await makeBot();

    await run(bot, "/permissions", { permissions: {} }, "integrations_only");

    expect(bot.getCommandPermissions()).toEqual(RAISED_TIERS);
    expect(JSON.parse(settings.get("discordCommandPermissions"))).toEqual(RAISED_TIERS);
  });

  it("a body naming only commands the caller may retune leaves the others alone", async () => {
    const bot = await makeBot();

    const response = await run(
      bot,
      "/permissions",
      { permissions: { status: "moderator" } },
      "integrations_only",
    );

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(bot.getCommandPermissions()).toEqual({ ...RAISED_TIERS, status: "moderator" });
  });

  it("integrations.manage alone can't set a mod role and then hand it /save, /broadcast and /kick", async () => {
    const bot = await makeBot();

    // Step 1 is allowed: nothing sits at the moderator tier.
    const config = await run(
      bot,
      "/config",
      {
        token: "KEEP_EXISTING",
        guildId: GUILD,
        adminRoleId: ADMIN_ROLE,
        modRoleId: ATTACKER_ROLE,
        channelId: CHANNEL,
      },
      "integrations_only",
    );
    expect(config.status).not.toHaveBeenCalledWith(403);
    expect(settings.get("discordModRoleId")).toBe(ATTACKER_ROLE);

    // Step 2, the reset, must not move any tier.
    await run(bot, "/permissions", { permissions: {} }, "integrations_only");

    for (const command of ["save", "broadcast", "kick", "rcon"]) {
      expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), command)).toBe(false);
    }
  });

  it("naming a raised command still needs its capability", async () => {
    const bot = await makeBot();

    const response = await run(
      bot,
      "/permissions",
      { permissions: { save: "moderator" } },
      "integrations_only",
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(bot.getCommandPermissions().save).toBe("admin");
  });

  it("the full set the settings page sends still saves for a caller holding every capability", async () => {
    const bot = await makeBot();
    const wanted = { ...RAISED_TIERS, save: "moderator", kick: "moderator" };

    const response = await run(bot, "/permissions", { permissions: wanted }, "admin");

    expect(response.status).not.toHaveBeenCalled();
    expect(bot.getCommandPermissions()).toEqual(wanted);
  });
});
