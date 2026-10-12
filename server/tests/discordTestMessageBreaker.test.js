import { describe, expect, it, vi } from "vitest";

// "Send test message" could not confirm a fix while the channel's circuit
// breaker was open: three failed sends open it for 5 minutes (30 for a
// permissions/channel problem), and every send in that time, the test message
// included, was dropped and answered "Discord rejected the message". The test
// message now goes out regardless and closes the breaker when it gets
// through; saving a different channel, guild or token starts the breakers
// afresh.

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
}));
vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: async () => null,
  writeUiSecretFile: () => {},
}));

const { DiscordBot } = await import("../services/discordBot.js");
const { default: router } = await import("../routes/discord.js");

const CHANNEL = "400000000000000001";
const GUILD = "100000000000000001";

function makeBot(send) {
  const bot = new DiscordBot(null, null, null, null);
  bot.isRunning = true;
  bot.channelId = CHANNEL;
  bot.guildId = GUILD;
  bot.token = "token";
  bot.client = {
    channels: {
      fetch: async () => ({ guildId: GUILD, isTextBased: () => true, send }),
    },
  };
  return bot;
}

function openBreaker(bot, channelId = CHANNEL) {
  const breaker = bot._breakerFor(channelId);
  breaker.failures = 3;
  breaker.openUntil = Date.now() + 30 * 60_000;
  return breaker;
}

async function postTestMessage(bot) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/test-message" && entry.route.methods.post,
  );
  const handler = layer.route.stack.at(-1).handle;
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await handler({ app: { get: () => bot } }, response);
  return response;
}

describe("POST /api/discord/test-message while the channel's circuit is open", () => {
  it("sends the message anyway and closes the circuit when it gets through", async () => {
    const send = vi.fn(async () => ({}));
    const bot = makeBot(send);
    const breaker = openBreaker(bot);

    const response = await postTestMessage(bot);

    expect(send).toHaveBeenCalledWith(expect.stringContaining("Test message"));
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(breaker.openUntil).toBe(0);
    expect(breaker.failures).toBe(0);

    // Real notifications flow again straight away.
    expect(await bot.sendNotification("server started")).toBe(true);
    expect(send).toHaveBeenCalledWith("server started");
  });

  it("a test message that still fails reports it and leaves the open circuit as it was", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("Missing Access"), { status: 403 });
    });
    const bot = makeBot(send);
    const breaker = openBreaker(bot);
    const openUntil = breaker.openUntil;

    const response = await postTestMessage(bot);

    expect(send).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(502);
    expect(breaker.openUntil).toBe(openUntil);
    expect(breaker.failures).toBe(3);
    // Ordinary traffic is still held back by the open circuit.
    expect(await bot.sendNotification("server started")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("DiscordBot.updateConfig() and open circuit breakers", () => {
  const OTHER_CHANNEL = "400000000000000002";
  const OTHER_GUILD = "100000000000000002";

  it("starts the breakers afresh when the channel changes", async () => {
    const bot = makeBot(vi.fn());
    const breaker = openBreaker(bot);

    await bot.updateConfig("token", GUILD, null, OTHER_CHANNEL, null);

    expect(bot._channelBreakers.size).toBe(0);
    expect(breaker.openUntil).toBeGreaterThan(0); // the old object, not the map, was left alone
  });

  it("starts the breakers afresh when the guild changes", async () => {
    const bot = makeBot(vi.fn());
    openBreaker(bot);

    await bot.updateConfig("token", OTHER_GUILD, null, CHANNEL, null);

    expect(bot._channelBreakers.size).toBe(0);
  });

  it("keeps an open breaker when the same settings are saved again", async () => {
    const bot = makeBot(vi.fn());
    openBreaker(bot);

    await bot.updateConfig("token", GUILD, null, CHANNEL, null);

    expect(bot._breakerFor(CHANNEL).openUntil).toBeGreaterThan(Date.now());
  });
});
