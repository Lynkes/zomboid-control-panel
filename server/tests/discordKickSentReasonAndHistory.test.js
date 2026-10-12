import { beforeEach, describe, expect, it, vi } from "vitest";

// Discord /kick showed the reason as typed although RCON got a folded,
// whitelisted copy (sanitizeForBanReason()) -- a reason made only of
// characters RCON cannot carry was sent as none while the reply and the
// channel notification still quoted it -- and, unlike POST /api/players/kick,
// it wrote no entry to the player action history. kickPlayer() now returns
// sentReason like banPlayer(), the reply shows that, and the kick is logged.

const logPlayerAction = vi.fn(async () => ({}));
vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logPlayerAction: (...args) => logPlayerAction(...args) };
});

const { DiscordBot } = await import("../services/discordBot.js");
const { RconService } = await import("../services/rcon.js");

function makeBot(kickResult) {
  const bot = Object.create(DiscordBot.prototype);
  bot.rconService = {
    connected: true,
    kickPlayer: vi.fn(async () => kickResult),
  };
  bot.sendNotification = vi.fn(async () => true);
  return bot;
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

beforeEach(() => {
  logPlayerAction.mockClear();
});

describe("Discord /kick shows and records the reason RCON received", () => {
  it("shows the folded reason that was sent, not the typed one", async () => {
    const bot = makeBot({ success: true, sentReason: "Comportement toxique repete" });
    const interaction = makeInteraction("Griefer", "Comportement toxique répété");

    await bot.handleKick(interaction);

    expect(interaction.replies[0]).toBe("👢 Kicked Griefer: Comportement toxique repete");
    expect(bot.sendNotification.mock.calls[0][0]).toContain("Reason: Comportement toxique repete");
  });

  it("says no reason was given when nothing of the typed reason could be sent", async () => {
    const bot = makeBot({ success: true, sentReason: "" });
    const interaction = makeInteraction("Griefer", "日本語");

    await bot.handleKick(interaction);

    expect(interaction.replies[0]).toBe("👢 Kicked Griefer: No reason given");
    expect(bot.sendNotification.mock.calls[0][0]).toContain("Reason: No reason given");
    expect(logPlayerAction).toHaveBeenCalledWith("Griefer", "kick", null);
  });

  it("writes the kick to the player action history with the reason sent", async () => {
    const bot = makeBot({ success: true, sentReason: "Building in the spawn zone" });

    await bot.handleKick(makeInteraction("Griefer", "Building in the spawn zone"));

    expect(logPlayerAction).toHaveBeenCalledWith("Griefer", "kick", "Building in the spawn zone");
  });

  it("does not record a kick RCON refused", async () => {
    const bot = makeBot({ success: false, error: "Not enough rights", sentReason: "spam" });
    const interaction = makeInteraction("Griefer", "spam");

    await bot.handleKick(interaction);

    expect(interaction.replies[0]).toMatch(/Kick failed/);
    expect(logPlayerAction).not.toHaveBeenCalled();
  });

  it("still answers when the history write fails", async () => {
    logPlayerAction.mockRejectedValueOnce(new Error("disk full"));
    const bot = makeBot({ success: true, sentReason: "spam" });
    const interaction = makeInteraction("Griefer", "spam");

    await bot.handleKick(interaction);

    expect(interaction.replies[0]).toBe("👢 Kicked Griefer: spam");
    expect(bot.sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe("RconService.kickPlayer() reports what it sent", () => {
  it("returns the sanitised reason as sentReason, next to the command result", async () => {
    const rcon = new RconService();
    vi.spyOn(rcon, "execute").mockResolvedValue({ success: true, response: "ok" });

    const result = await rcon.kickPlayer("Bob", "Comportement toxique répété");

    expect(result).toEqual({ success: true, response: "ok", sentReason: "Comportement toxique repete" });
  });

  it("returns an empty sentReason when no reason was sent", async () => {
    const rcon = new RconService();
    vi.spyOn(rcon, "execute").mockResolvedValue({ success: true, response: "ok" });

    expect((await rcon.kickPlayer("Bob")).sentReason).toBe("");
    expect((await rcon.kickPlayer("Bob", "日本語")).sentReason).toBe("");
  });
});
