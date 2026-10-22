import { describe, expect, it, vi } from "vitest";
import { DiscordBot } from "../services/discordBot.js";

// /kick sent RCON a reason cut at 100 characters (sanitizeForBanReason()),
// but its Discord reply and channel notification used the reason as typed,
// and a slash option can be 6000 characters. The reply then went over
// Discord's 2000-character limit AFTER the kick had succeeded: the moderator
// saw an error, and the channel notification was never sent.

function makeBot() {
  const bot = Object.create(DiscordBot.prototype);
  const executed = [];
  bot.rconService = {
    connected: true,
    sanitizeQuotedArg: (s) => s,
    sanitizeForBanReason: (s) =>
      s ? String(s).replace(/[^a-zA-Z0-9\s.,!?'-]/g, "").substring(0, 100) : "",
    execute: async (cmd) => {
      executed.push(cmd);
      return { success: true };
    },
    kickPlayer(username, reason = "") {
      const safeReason = this.sanitizeForBanReason(reason);
      let cmd = `kickuser "${this.sanitizeQuotedArg(username)}"`;
      if (safeReason) cmd += ` -r "${safeReason}"`;
      return this.execute(cmd);
    },
  };
  bot.sendNotification = vi.fn(async () => true);
  return { bot, executed };
}

function makeInteraction(player, reason) {
  const replies = [];
  return {
    replies,
    deferReply: async () => {},
    editReply: vi.fn(async (message) => replies.push(message)),
    options: { getString: (name) => (name === "player" ? player : (reason ?? null)) },
    user: { tag: "mod#0001" },
  };
}

describe("Discord /kick reply with a long reason", () => {
  it("shows at most the 100 characters RCON got, and still notifies the channel", async () => {
    const { bot, executed } = makeBot();
    const interaction = makeInteraction("Griefer", "a".repeat(6000));

    await bot.handleKick(interaction);

    expect(executed).toEqual([`kickuser "Griefer" -r "${"a".repeat(100)}"`]);
    const reply = interaction.replies[0];
    expect(reply).toBe(`👢 Kicked Griefer: ${"a".repeat(100)}`);
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(bot.sendNotification).toHaveBeenCalledTimes(1);
    const notification = bot.sendNotification.mock.calls[0][0];
    expect(notification).toContain(`Reason: ${"a".repeat(100)}`);
    expect(notification).not.toContain("a".repeat(101));
    expect(notification.length).toBeLessThanOrEqual(2000);
  });

  it("stays under 2000 characters when markdown escaping doubles the reason", async () => {
    const { bot } = makeBot();
    const interaction = makeInteraction("Griefer", "*".repeat(6000));

    await bot.handleKick(interaction);

    // 100 reason characters, each at most doubled by the escaping.
    expect(interaction.replies[0].length).toBeLessThan(300);
  });

  it("cuts by character, not in the middle of an emoji", async () => {
    const { bot } = makeBot();
    const emoji = String.fromCodePoint(0x1f600);
    const interaction = makeInteraction("Griefer", emoji.repeat(150));

    await bot.handleKick(interaction);

    expect(interaction.replies[0]).toBe(`👢 Kicked Griefer: ${emoji.repeat(100)}`);
  });

  it("leaves a short reason alone, and says so when there is none", async () => {
    const { bot } = makeBot();
    const short = makeInteraction("Griefer", "Building in the spawn zone");
    await bot.handleKick(short);
    expect(short.replies[0]).toBe("👢 Kicked Griefer: Building in the spawn zone");

    const none = makeInteraction("Griefer", null);
    await bot.handleKick(none);
    expect(none.replies[0]).toBe("👢 Kicked Griefer: No reason given");
  });
});
