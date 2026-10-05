import { beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep AUTHZ-3: PUT /discord/config had no capability check
// beyond the router-wide integrations.manage gate. A custom role holding
// integrations.manage but not rcon.execute / server.control could point the
// bot's admin role (or mod role) at a Discord role it controls -- or swap in
// its own bot token or a guild it owns, which makes it the guild owner that
// discordBot.checkPermission() always lets through -- and then run /rcon,
// /stop, /start, /restart from Discord. PUT /permissions already refused
// the same escalation through the command tiers
// (discordCommandPermissionsCapabilityGate.test.js); this is the other door.
//
// Fix: routes/discord.js refuses a token, guild ID, admin role ID or mod
// role ID change unless the caller holds every capability of the commands
// that change unlocks.
//
// These tests drive the real route against the real DiscordBot (only the
// settings store, the secret file and the discord.js Client are faked), so
// a refusal is proven by what the bot would then let a Discord member do,
// not just by a status code.

const { settings, secrets } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
}));

const ALL_COMMAND_CAPABILITIES = [
  "players.view",
  "server.control",
  "server.world_events",
  "players.moderate",
  "rcon.execute",
];

const ROLES = {
  admin: { capabilities: ["integrations.manage", ...ALL_COMMAND_CAPABILITIES] },
  // Passes the router-level gate and holds nothing a bot command maps to.
  integrations_only: { capabilities: ["integrations.manage"] },
  // Exactly what the default moderator-tier commands (/save, /broadcast,
  // /kick) map to -- but not /players' players.view or /rcon's rcon.execute.
  integrations_and_mod_tier: {
    capabilities: [
      "integrations.manage",
      "server.control",
      "server.world_events",
      "players.moderate",
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
const ATTACKER_GUILD = "100000000000000099";
const ADMIN_ROLE = "200000000000000001";
const ATTACKER_ROLE = "300000000000000001";
const CHANNEL = "400000000000000001";
const OTHER_CHANNEL = "400000000000000002";
const BOT_TOKEN = "operators-bot-token";

function seedConfiguredBot({ commandPermissions } = {}) {
  settings.clear();
  secrets.clear();
  secrets.set("discordBotToken", BOT_TOKEN);
  settings.set("discordGuildId", GUILD);
  settings.set("discordAdminRoleId", ADMIN_ROLE);
  // updateConfig() stores a missing mod role as "", not null.
  settings.set("discordModRoleId", "");
  settings.set("discordChannelId", CHANNEL);
  if (commandPermissions) {
    settings.set("discordCommandPermissions", JSON.stringify(commandPermissions));
  }
}

async function makeBot() {
  const bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  await bot.loadConfig();
  return bot;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Runs the router-level requirePermission("integrations.manage") layer
// ahead of PUT /config's own handlers, same as
// discordCommandPermissionsCapabilityGate.test.js.
async function putConfig(bot, body, role) {
  const useLayer = router.stack.find(
    (entry) => !entry.route && typeof entry.handle === "function",
  );
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === "/config" && entry.route.methods.put,
  );
  const handlers = [useLayer.handle, ...routeLayer.route.stack.map((s) => s.handle)];

  const response = createResponse();
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

// What the settings page sends on every save: the token placeholder and
// every field, changed or not (Discord.tsx handleSaveConfig, which turns an
// empty role ID into undefined).
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

// A Discord member of the configured guild who is neither its owner nor a
// Discord Administrator, holding only the given roles.
function interactionFrom(roleIds) {
  return {
    user: { id: "500000000000000001" },
    guild: { ownerId: "500000000000000999" },
    member: { roles: roleIds },
  };
}

function expectRefused(response, missing) {
  expect(response.status).toHaveBeenCalledWith(403);
  const payload = response.json.mock.calls[0][0];
  expect(payload.code).toBe("DISCORD_CONFIG_CAPABILITY_REQUIRED");
  expect([...payload.missing].sort()).toEqual([...missing].sort());
  expect(payload.params.detail).toBe(payload.missing.join(", "));
}

function expectSaved(response) {
  expect(response.status).not.toHaveBeenCalled();
  expect(response.json).toHaveBeenCalledWith(
    expect.objectContaining({ success: true }),
  );
}

describe("PUT /discord/config -- changes that unlock bot commands need those commands' capabilities", () => {
  beforeEach(() => {
    seedConfiguredBot();
  });

  it("integrations.manage alone cannot point the admin role at a Discord role it controls", async () => {
    const bot = await makeBot();
    expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), "rcon")).toBe(false);

    const response = await putConfig(
      bot,
      resendBody({ adminRoleId: ATTACKER_ROLE }),
      "integrations_only",
    );

    expectRefused(response, ALL_COMMAND_CAPABILITIES);
    expect(settings.get("discordAdminRoleId")).toBe(ADMIN_ROLE);
    expect(bot.adminRoleId).toBe(ADMIN_ROLE);
    for (const command of ["rcon", "stop", "start", "restart"]) {
      expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), command)).toBe(false);
    }
  });

  it("integrations.manage alone cannot set a mod role while /save, /broadcast and /kick sit at the moderator tier", async () => {
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({ modRoleId: ATTACKER_ROLE }),
      "integrations_only",
    );

    expectRefused(response, ["server.control", "server.world_events", "players.moderate"]);
    expect(settings.get("discordModRoleId")).toBe("");
    expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), "save")).toBe(false);
    expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), "kick")).toBe(false);
  });

  it("integrations.manage alone cannot swap in its own bot token", async () => {
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({ token: "attackers-own-bot-token" }),
      "integrations_only",
    );

    expectRefused(response, ALL_COMMAND_CAPABILITIES);
    expect(secrets.get("discordBotToken")).toBe(BOT_TOKEN);
    expect(bot.token).toBe(BOT_TOKEN);
  });

  it("integrations.manage alone cannot move the bot to a guild it owns", async () => {
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({ guildId: ATTACKER_GUILD }),
      "integrations_only",
    );

    expectRefused(response, ALL_COMMAND_CAPABILITIES);
    expect(settings.get("discordGuildId")).toBe(GUILD);
    expect(bot.guildId).toBe(GUILD);
  });

  it("clearing the admin role counts as a change too (fails closed)", async () => {
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({ adminRoleId: undefined }),
      "integrations_only",
    );

    expectRefused(response, ALL_COMMAND_CAPABILITIES);
    expect(settings.get("discordAdminRoleId")).toBe(ADMIN_ROLE);
  });

  it("an unchanged resend still saves the settings that unlock nothing, with integrations.manage alone", async () => {
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({
        channelId: OTHER_CHANNEL,
        autoStart: false,
        chatRelayEnabled: false,
        chatRelayScope: "general",
      }),
      "integrations_only",
    );

    expectSaved(response);
    expect(settings.get("discordChannelId")).toBe(OTHER_CHANNEL);
    expect(settings.get("discordAutoStart")).toBe(false);
    expect(settings.get("discordChatRelayEnabled")).toBe(false);
    expect(settings.get("discordChatRelayScope")).toBe("general");
    expect(settings.get("discordAdminRoleId")).toBe(ADMIN_ROLE);
    expect(secrets.get("discordBotToken")).toBe(BOT_TOKEN);
  });

  it("the mod role check follows the live tiers: with no command at the moderator tier, setting a mod role unlocks nothing", async () => {
    seedConfiguredBot({
      commandPermissions: {
        status: "everyone",
        players: "everyone",
        save: "admin",
        broadcast: "admin",
        kick: "admin",
        start: "admin",
        stop: "admin",
        restart: "admin",
        rcon: "admin",
      },
    });
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({ modRoleId: ATTACKER_ROLE }),
      "integrations_only",
    );

    expectSaved(response);
    expect(settings.get("discordModRoleId")).toBe(ATTACKER_ROLE);
    expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), "kick")).toBe(false);
    expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), "rcon")).toBe(false);
  });

  it("a role holding the moderator-tier capabilities may set the mod role, but still not the admin role", async () => {
    const bot = await makeBot();

    const modResponse = await putConfig(
      bot,
      resendBody({ modRoleId: ATTACKER_ROLE }),
      "integrations_and_mod_tier",
    );
    expectSaved(modResponse);
    expect(settings.get("discordModRoleId")).toBe(ATTACKER_ROLE);

    const adminResponse = await putConfig(
      bot,
      resendBody({ modRoleId: ATTACKER_ROLE, adminRoleId: ATTACKER_ROLE }),
      "integrations_and_mod_tier",
    );
    expectRefused(adminResponse, ["players.view", "rcon.execute"]);
    expect(settings.get("discordAdminRoleId")).toBe(ADMIN_ROLE);
    expect(bot.checkPermission(interactionFrom([ATTACKER_ROLE]), "rcon")).toBe(false);
  });

  it("a caller holding every command capability can change the token, guild and both roles", async () => {
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({
        token: "rotated-bot-token",
        guildId: ATTACKER_GUILD,
        adminRoleId: ATTACKER_ROLE,
        modRoleId: "300000000000000002",
      }),
      "admin",
    );

    expectSaved(response);
    expect(secrets.get("discordBotToken")).toBe("rotated-bot-token");
    expect(settings.get("discordGuildId")).toBe(ATTACKER_GUILD);
    expect(settings.get("discordAdminRoleId")).toBe(ATTACKER_ROLE);
    expect(settings.get("discordModRoleId")).toBe("300000000000000002");
  });

  it("the router-level integrations.manage gate still applies underneath", async () => {
    const bot = await makeBot();

    const response = await putConfig(
      bot,
      resendBody({ channelId: OTHER_CHANNEL }),
      "no_such_role",
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(settings.get("discordChannelId")).toBe(CHANNEL);
  });
});
