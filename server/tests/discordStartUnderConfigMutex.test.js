import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Security sweep 2026-10-05, HT4d: POST /discord/start ran outside the
// config mutex that /config and /reset hold. start() reads the token, then
// waits up to 30s for the gateway login; isRunning only comes true once
// that is done. A wipe landing in that window cleared the token, found no
// running bot to stop, and returned -- then the login finished and the
// bot stayed connected with the wiped token. POST /start (and /stop) now
// take the mutex too, so the wipe waits and then stops the bot it finds.
//
// Drives the real DiscordBot and routes; only the settings store, the
// secret file, discord.js's Client (helpers/fakeDiscordClient.js, with the
// login held open by the test) and fetch are faked.

const { settings, secrets } = vi.hoisted(() => ({
  settings: new Map(),
  secrets: new Map(),
}));

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
  getRoleByName: vi.fn(async () => ({ capabilities: ["integrations.manage"] })),
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
const { FakeDiscordClient, fakeDiscordClients } = await import("./helpers/fakeDiscordClient.js");

function run(bot, method, path) {
  const useLayer = router.stack.find((entry) => !entry.route && typeof entry.handle === "function");
  const routeLayer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  const handlers = [useLayer.handle, ...routeLayer.route.stack.map((s) => s.handle)];
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = { user: { role: "integrator" }, app: { get: () => bot }, body: {} };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  return next().then(() => response);
}

async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

let bot;

beforeEach(async () => {
  settings.clear();
  secrets.clear();
  secrets.set("discordBotToken", "operators-bot-token");
  settings.set("discordGuildId", "100000000000000001");
  settings.set("discordChannelId", "400000000000000001");
  FakeDiscordClient.autoReady = false;
  fakeDiscordClients.length = 0;
  bot = new DiscordBot({ connected: false }, {}, { on: vi.fn() }, null);
  bot.registerCommands = vi.fn(async () => {});
  bot._startPresenceUpdates = vi.fn();
  await bot.loadConfig();
});

afterEach(async () => {
  FakeDiscordClient.autoReady = true;
  await bot.stop();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("POST /discord/start and a wipe don't interleave", () => {
  it("a wipe sent while the bot is logging in leaves no bot connected with the wiped token", async () => {
    const starting = run(bot, "post", "/start");
    await until(() => fakeDiscordClients.length === 1);
    const client = fakeDiscordClients[0];
    expect(client.loginToken).toBe("operators-bot-token");

    const wiping = run(bot, "post", "/reset");
    // Give the wipe every chance to run ahead of the login.
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.finishLogin();
    const [started, wiped] = await Promise.all([starting, wiping]);

    expect(started.json).toHaveBeenCalledWith({ success: true, message: "Discord bot started" });
    expect(wiped.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(secrets.get("discordBotToken")).toBe("");
    expect(bot.token).toBeNull();
    expect(bot.isRunning).toBe(false);
    expect(bot.client).toBeNull();
    expect(client.destroyed).toBe(true);
  });

  it("a stop sent while the bot is logging in waits for it and stops it", async () => {
    const starting = run(bot, "post", "/start");
    await until(() => fakeDiscordClients.length === 1);
    const client = fakeDiscordClients[0];

    const stopping = run(bot, "post", "/stop");
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.finishLogin();
    const [, stopped] = await Promise.all([starting, stopping]);

    expect(stopped.json).toHaveBeenCalledWith({ success: true, message: "Discord bot stopped" });
    expect(bot.isRunning).toBe(false);
    expect(client.destroyed).toBe(true);
  });

  it("legit: start, then stop, one after the other", async () => {
    FakeDiscordClient.autoReady = true;

    const started = await run(bot, "post", "/start");
    expect(started.json).toHaveBeenCalledWith({ success: true, message: "Discord bot started" });
    expect(bot.isRunning).toBe(true);

    const again = await run(bot, "post", "/start");
    expect(again.json).toHaveBeenCalledWith({ success: true, message: "Bot is already running" });

    const stopped = await run(bot, "post", "/stop");
    expect(stopped.json).toHaveBeenCalledWith({ success: true, message: "Discord bot stopped" });
    expect(bot.isRunning).toBe(false);
  });
});
