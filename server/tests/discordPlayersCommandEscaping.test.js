import { describe, expect, it, vi } from "vitest";

// /players put each name in an embed description with escapeMarkdown() but
// without { maskedLink: true }, unlike /leaderboard and the notifications. An
// embed description renders [text](https://...) as a link, so a player named
// that way showed a clickable link (to anywhere) in the channel.

vi.mock("../database/init.js", () => ({ getActiveServer: vi.fn(async () => ({ id: "s1" })) }));
vi.mock("../services/panelBridge.js", () => ({ default: { isModConnected: vi.fn(() => false) } }));
vi.mock("../services/managedContainer.js", () => ({
  resolveDockerHostSignal: vi.fn(),
  runManagedLifecycle: vi.fn(async () => ({ handled: false })),
}));

const { DiscordBot } = await import("../services/discordBot.js");

async function playersEmbed(names) {
  const bot = Object.create(DiscordBot.prototype);
  bot.serverManager = {
    getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
  };
  bot.rconService = {
    connected: true,
    getPlayers: async () => ({ success: true, players: names.map((name) => ({ name })) }),
  };
  const replies = [];
  await bot.handlePlayers({
    deferReply: async () => {},
    editReply: async (reply) => replies.push(reply),
  });
  return replies.at(-1).embeds[0].data;
}

describe("Discord /players escapes what an embed would render", () => {
  it("does not turn a masked-link name into a link", async () => {
    const embed = await playersEmbed(["[click me](https://example.com)"]);

    // The opening bracket is escaped, which is what stops the link forming.
    expect(embed.description).toBe("• \\[click me](https://example.com)");
  });

  it("still escapes ordinary markdown and lists plain names as they are", async () => {
    const embed = await playersEmbed(["alice", "carol_*"]);

    expect(embed.description.split("\n")).toEqual(["• alice", "• carol\\_\\*"]);
  });

  it("keeps a name with a line break on one line", async () => {
    const embed = await playersEmbed(["Bob\n• Admin"]);

    expect(embed.description).toBe("• Bob • Admin");
  });
});
