import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auto-start at boot tried once. The network is often not up yet when the
// panel starts with the machine, so a Discord that was merely unreachable
// left the bot down until someone noticed. A failure that is the network's
// (not a bad token or missing intents) is now retried in the background with
// backoff; stop() and a manual start end the retries.

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
}));

const { DiscordBot, isTransientDiscordError, START_ALREADY_IN_PROGRESS } = await import(
  "../services/discordBot.js"
);

function makeBot(results) {
  const bot = new DiscordBot(null, null, null, null);
  bot.token = "token";
  bot.guildId = "100000000000000001";
  const queue = [...results];
  bot.start = vi.fn(async () => {
    const next = queue.shift();
    if (next.ok) {
      bot.isRunning = true;
      return true;
    }
    bot.lastStartError = next.error;
    return false;
  });
  return bot;
}

const NETWORK_DOWN = { kind: null, message: "getaddrinfo ENOTFOUND discord.com", transient: true };
const BAD_TOKEN = { kind: "TokenInvalid", message: "An invalid token was provided.", transient: false };

describe("isTransientDiscordError()", () => {
  it("is true for the network's and Discord's own failures", () => {
    expect(isTransientDiscordError(new Error("getaddrinfo ENOTFOUND discord.com"))).toBe(true);
    expect(isTransientDiscordError(new Error("fetch failed"))).toBe(true);
    expect(isTransientDiscordError(Object.assign(new Error("Connect Timeout Error"), {}))).toBe(true);
    expect(isTransientDiscordError(Object.assign(new Error("Bot ready timeout after 30s"), { code: "ReadyTimeout" }))).toBe(true);
    expect(isTransientDiscordError(Object.assign(new Error("Service Unavailable"), { status: 503 }))).toBe(true);
    expect(isTransientDiscordError(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }))).toBe(true);
  });

  it("is false for a bad token, missing intents or a missing channel", () => {
    expect(isTransientDiscordError(Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" }))).toBe(false);
    expect(isTransientDiscordError(Object.assign(new Error("Privileged intent provided is not enabled or whitelisted."), { code: "DisallowedIntents" }))).toBe(false);
    expect(isTransientDiscordError(Object.assign(new Error("Missing Access"), { status: 403 }))).toBe(false);
    expect(isTransientDiscordError(undefined)).toBe(false);
  });
});

describe("DiscordBot.scheduleAutoStartRetry()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the bot on a later attempt once the network is back, without blocking the caller", async () => {
    const bot = makeBot([{ ok: false, error: NETWORK_DOWN }, { ok: true }]);

    bot.scheduleAutoStartRetry([1000, 2000, 4000]);
    expect(bot.start).not.toHaveBeenCalled(); // scheduled, not run inline

    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(bot.isRunning).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(bot.start).toHaveBeenCalledTimes(2);
    expect(bot.isRunning).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(bot.start).toHaveBeenCalledTimes(2); // nothing further scheduled
  });

  it("gives up after the last delay", async () => {
    const bot = makeBot(Array.from({ length: 5 }, () => ({ ok: false, error: NETWORK_DOWN })));

    bot.scheduleAutoStartRetry([1000, 1000]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(bot.start).toHaveBeenCalledTimes(2);
  });

  it("stops retrying on a failure that is not the network's", async () => {
    const bot = makeBot([{ ok: false, error: BAD_TOKEN }, { ok: true }]);

    bot.scheduleAutoStartRetry([1000, 1000, 1000]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(bot.isRunning).toBe(false);
  });

  it("does not start a bot that was started by hand in the meantime", async () => {
    const bot = makeBot([{ ok: true }]);

    bot.scheduleAutoStartRetry([1000]);
    bot.isRunning = true;
    await vi.advanceTimersByTimeAsync(5000);

    expect(bot.start).not.toHaveBeenCalled();
  });

  it("is cancelled by stop(), so a bot someone stopped is not started behind their back", async () => {
    const bot = makeBot([{ ok: true }]);

    bot.scheduleAutoStartRetry([1000]);
    await bot.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(bot.start).not.toHaveBeenCalled();
  });

  it("does not retry once the token is gone", async () => {
    const bot = makeBot([{ ok: true }]);

    bot.scheduleAutoStartRetry([1000]);
    bot.token = null;
    await vi.advanceTimersByTimeAsync(5000);

    expect(bot.start).not.toHaveBeenCalled();
  });

  it("leaves a start someone else has in flight alone", async () => {
    const bot = makeBot([]);
    bot.start = vi.fn(async () => START_ALREADY_IN_PROGRESS);

    bot.scheduleAutoStartRetry([1000, 1000]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(bot.start).toHaveBeenCalledTimes(1);
  });

  it("scheduling again replaces the pending retry instead of doubling it", async () => {
    const bot = makeBot([{ ok: false, error: NETWORK_DOWN }, { ok: false, error: NETWORK_DOWN }]);

    bot.scheduleAutoStartRetry([1000]);
    bot.scheduleAutoStartRetry([1000]);
    await vi.advanceTimersByTimeAsync(1500);

    expect(bot.start).toHaveBeenCalledTimes(1);
  });
});

// The flag the boot-time retry reads is set by the real start().
describe("DiscordBot.start() marks why it failed", () => {
  async function startFailingWith(error) {
    vi.resetModules();
    vi.doMock("discord.js", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        Client: class {
          constructor() {
            this.on = vi.fn();
            this.once = vi.fn();
            this.login = vi.fn(async () => {
              throw error;
            });
            this.destroy = vi.fn();
          }
        },
      };
    });
    vi.doMock("../utils/uiSecretFile.js", () => ({
      loadUiSecret: vi.fn(async () => "fake-bot-token"),
      writeUiSecretFile: vi.fn(),
    }));
    vi.doMock("../database/init.js", () => ({
      getActiveServer: vi.fn(async () => null),
      getSetting: vi.fn(async () => null),
      setSetting: vi.fn(async () => {}),
    }));
    const { DiscordBot: FreshBot } = await import("../services/discordBot.js");
    const bot = new FreshBot({ connected: false }, {}, { on: vi.fn() }, null);
    bot.guildId = "100000000000000001";
    const started = await bot.start();
    return { started, lastStartError: bot.lastStartError, status: bot.getStatus() };
  }

  it("a network failure is transient, and getStatus() keeps the flag to itself", async () => {
    const { started, lastStartError, status } = await startFailingWith(new Error("getaddrinfo ENOTFOUND discord.com"));

    expect(started).toBe(false);
    expect(lastStartError).toMatchObject({ transient: true });
    expect(Object.keys(status.lastStartError).sort()).toEqual(["kind", "message"]);
  });

  it("a rejected token is not", async () => {
    const { lastStartError } = await startFailingWith(
      Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" }),
    );

    expect(lastStartError).toMatchObject({ kind: "TokenInvalid", transient: false });
  });
});
