import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordBot } from "../services/discordBot.js";

// Every panel-initiated start posted "Server Started" twice: the status
// watchdog posts it as soon as the process appears (about a second after
// spawn) and waitForRconAfterStart posts it again once RCON answers, which
// takes PZ 60-180 s -- outside the old one-minute lifecycle dedupe window.
// A repeat of the same start inside the RCON wait is now one transition,
// while a stop in between (a genuine restart) still lets the next start post.

function makeBot() {
  const bot = Object.create(DiscordBot.prototype);
  bot.isRunning = true;
  bot.channelId = "123456789012345678";
  bot.webhookEvents = {
    serverStart: { enabled: true, template: "Server started" },
    serverStop: { enabled: true, template: "Server stopped" },
  };
  bot._lastLifecycleState = null;
  bot._lastLifecycleAt = 0;
  bot._lifecycleNotificationChain = Promise.resolve();
  bot._lifecycleNotificationGeneration = 0;
  const sent = [];
  bot.sendNotification = async (msg) => {
    sent.push(msg);
    return true;
  };
  return { bot, sent };
}

describe("lifecycle notifications: a start reported twice during one RCON wait is posted once", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the route's serverStart three minutes after the watchdog's", async () => {
    const { bot, sent } = makeBot();

    await bot.sendEventNotification("serverStart", {}); // watchdog: process appeared
    vi.advanceTimersByTime(3 * 60_000);
    await bot.sendEventNotification("serverStart", {}); // route: RCON connected

    expect(sent).toEqual(["Server started"]);
  });

  it("posts the next start after a stop, however soon the stop followed", async () => {
    const { bot, sent } = makeBot();

    await bot.sendEventNotification("serverStart", {});
    vi.advanceTimersByTime(90_000);
    await bot.sendEventNotification("serverStop", {});
    vi.advanceTimersByTime(30_000);
    await bot.sendEventNotification("serverStart", {});

    expect(sent).toEqual(["Server started", "Server stopped", "Server started"]);
  });

  it("posts a start again once the RCON-wait window has passed with no stop in between", async () => {
    const { bot, sent } = makeBot();

    await bot.sendEventNotification("serverStart", {});
    vi.advanceTimersByTime(11 * 60_000);
    await bot.sendEventNotification("serverStart", {});

    expect(sent).toEqual(["Server started", "Server started"]);
  });

  it("keeps the one-minute window for a stop reported by both the route and the watchdog", async () => {
    const { bot, sent } = makeBot();

    await bot.sendEventNotification("serverStop", {});
    vi.advanceTimersByTime(10_000);
    await bot.sendEventNotification("serverStop", {});
    expect(sent).toEqual(["Server stopped"]);

    vi.advanceTimersByTime(61_000);
    await bot.sendEventNotification("serverStop", {});
    expect(sent).toEqual(["Server stopped", "Server stopped"]);
  });
});
