import { describe, expect, it } from "vitest";
import { DiscordBot } from "../services/discordBot.js";

// {player} (and every other value substituted into an event notification) was
// escaped for markdown but not flattened or capped. A name can hold line
// breaks (a co-op player's name skips the server's username check), so a
// crafted name could add lines of its own to a join/death message, and a very
// long one filled the message. Values are now flattened and capped at 64
// characters like leaderboard names, before the markdown escaping.

function makeBot(webhookEvents) {
  const bot = Object.create(DiscordBot.prototype);
  bot.isRunning = true;
  bot.channelId = "123456789012345678";
  bot.webhookEvents = webhookEvents;
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

const JOIN = { playerJoin: { enabled: true, template: "{player} has joined the server!" } };

describe("event notification values are flattened and capped", () => {
  it("turns line breaks in a name into spaces, so it cannot add lines to the message", async () => {
    const { bot, sent } = makeBot(JOIN);

    await bot.sendEventNotification("playerJoin", { player: "Bob\n🟢 **Server Started**\r\nAll good" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/[\r\n]/);
    expect(sent[0]).toBe("Bob 🟢 \\*\\*Server Started\\*\\* All good has joined the server!");
  });

  it("caps a long name at 64 characters and marks the cut", async () => {
    const { bot, sent } = makeBot(JOIN);

    await bot.sendEventNotification("playerJoin", { player: "x".repeat(200) });

    expect(sent[0]).toBe(`${"x".repeat(64)}… has joined the server!`);
  });

  it("does not cut an escape sequence in half", async () => {
    const { bot, sent } = makeBot(JOIN);

    await bot.sendEventNotification("playerJoin", { player: "a*".repeat(50) });

    // 100 characters cut to 64 = 32 pairs, each "a*" escaped as "a\*".
    expect(sent[0]).toBe(`${"a\\*".repeat(32)}… has joined the server!`);
  });

  it("leaves the operator's own newlines in the template alone", async () => {
    const { bot, sent } = makeBot({
      playerDeath: { enabled: true, template: "💀 **{player}** died\nat {location}" },
    });

    await bot.sendEventNotification("playerDeath", { player: "Ann", location: "100,200,0" });

    expect(sent[0]).toBe("💀 **Ann** died\nat 100,200,0");
  });

  it("still renders numbers and missing values the way it did", async () => {
    const { bot, sent } = makeBot({
      scheduledRestart: { enabled: true, template: "Restart in {minutes} min{missing}" },
    });

    await bot.sendEventNotification("scheduledRestart", { minutes: 5, missing: undefined });

    expect(sent[0]).toBe("Restart in 5 min");
  });
});
