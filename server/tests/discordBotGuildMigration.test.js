import { beforeEach, describe, expect, it, vi } from "vitest";

const { restInstances, settings, hangNextPut } = vi.hoisted(() => ({
  restInstances: [],
  settings: new Map(),
  hangNextPut: { value: false },
}));

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    REST: class {
      constructor() {
        this.token = null;
        this.put = vi.fn(async (...args) => {
          this.lastPut = args;
          if (hangNextPut.value) return new Promise(() => {});
        });
        restInstances.push(this);
      }

      setToken(token) {
        this.token = token;
        return this;
      }
    },
  };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => settings.get(key) ?? null),
  setSetting: vi.fn(async (key, value) => {
    settings.set(key, value);
  }),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../utils/uiSecretFile.js", () => ({
  loadUiSecret: vi.fn(async () => null),
  writeUiSecretFile: vi.fn(),
}));

const { DiscordBot } = await import("../services/discordBot.js");

describe("DiscordBot.updateConfig(): guild migration cleanup credentials", () => {
  beforeEach(() => {
    settings.clear();
    restInstances.length = 0;
  });

  it("clears the old guild with the old token when rotating token and guild together", async () => {
    const bot = new DiscordBot(null, null, null, null);
    bot.token = "old-token";
    bot.guildId = "111111111111111";
    bot.channelId = "222222222222222";
    bot.client = { user: { id: "old-application" } };
    bot.isRunning = true;

    await bot.updateConfig(
      "new-token",
      "333333333333333",
      null,
      "444444444444444",
      null,
    );

    expect(restInstances).toHaveLength(1);
    expect(restInstances[0].token).toBe("old-token");
    expect(restInstances[0].lastPut[0]).toContain("111111111111111");
    expect(bot.token).toBe("new-token");
    expect(bot.guildId).toBe("333333333333333");
  });

  it("bounds a slash-command registration that never settles", async () => {
    vi.useFakeTimers();
    try {
      const bot = new DiscordBot(null, null, null, null);
      bot.token = "token";
      bot.guildId = "111111111111111";
      bot.client = { user: { id: "application" } };
      bot.getCommands = () => [];

      hangNextPut.value = true;
      const resultPromise = bot.registerCommands();
      const rejection = expect(resultPromise).rejects.toMatchObject({ code: "ETIMEDOUT" });
      await vi.advanceTimersByTimeAsync(31_000);

      await rejection;
    } finally {
      hangNextPut.value = false;
      vi.useRealTimers();
    }
  });
});