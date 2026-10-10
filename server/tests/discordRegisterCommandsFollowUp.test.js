import { beforeEach, describe, expect, it, vi } from "vitest";

// registerCommands() used to hand a caller that arrived while a registration
// was in flight that same registration's promise. The list it was pushing was
// built when it started, so a tier saved in the meantime (PUT
// /discord/permissions -> updateCommandPermissions() -> registerCommands())
// was never pushed to Discord; Discord kept the old command visibility until
// the next restart.
//
// Now one follow-up registration runs after the in-flight one settles, builds
// its list from the tiers then, and is shared by every caller that arrives
// meanwhile.

const { puts } = vi.hoisted(() => ({ puts: [] }));

// Each REST.put() stays pending until the test settles it.
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    REST: class {
      setToken() {
        return this;
      }

      put(route, { body }) {
        return new Promise((resolve, reject) => {
          puts.push({ route, body, resolve, reject });
        });
      }
    },
  };
});

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { DiscordBot } = await import("../services/discordBot.js");

// "moderator" with no mod/admin role set hides the command behind Discord's
// ManageMessages permission; "everyone" leaves it unrestricted. That is the
// part of the pushed list a tier change moves.
const MANAGE_MESSAGES = "8192";

function kickPermission(put) {
  return put.body.find((command) => command.name === "kick").default_member_permissions ?? null;
}

function makeBot() {
  const bot = new DiscordBot(null, null, null, null);
  bot.token = "token";
  bot.guildId = "111111111111111";
  bot.client = { user: { id: "application" } };
  bot.commandPermissions = { ...bot.commandPermissions, kick: "moderator" };
  return bot;
}

describe("registerCommands() during a registration in flight", () => {
  beforeEach(() => {
    puts.length = 0;
  });

  it("pushes the latest tiers in one follow-up after the in-flight one settles", async () => {
    const bot = makeBot();

    const first = bot.registerCommands();
    expect(puts).toHaveLength(1);
    expect(kickPermission(puts[0])).toBe(MANAGE_MESSAGES);

    // A tier is saved while the first PUT is still out.
    bot.commandPermissions.kick = "everyone";
    const second = bot.registerCommands();
    await Promise.resolve();
    expect(puts, "no second PUT until the first has settled").toHaveLength(1);

    puts[0].resolve();
    await first;
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(kickPermission(puts[1])).toBeNull();

    let secondSettled = false;
    second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled, "the caller waits for its own change to be pushed").toBe(false);

    puts[1].resolve();
    await second;
    expect(puts).toHaveLength(2);
  });

  it("coalesces every call made meanwhile into a single follow-up", async () => {
    const bot = makeBot();

    const first = bot.registerCommands();
    bot.commandPermissions.kick = "admin";
    const others = [bot.registerCommands(), bot.registerCommands()];
    bot.commandPermissions.kick = "everyone";
    others.push(bot.registerCommands());

    puts[0].resolve();
    await first;
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    // The follow-up reads the tiers when it runs, so it carries the last one.
    expect(kickPermission(puts[1])).toBeNull();
    puts[1].resolve();
    await Promise.all(others);

    expect(puts).toHaveLength(2);
  });

  it("still runs the follow-up when the in-flight registration fails, and each caller gets its own outcome", async () => {
    const bot = makeBot();

    const first = bot.registerCommands();
    const firstOutcome = first.then(
      () => "resolved",
      (error) => error.message,
    );
    bot.commandPermissions.kick = "everyone";
    const second = bot.registerCommands();

    puts[0].reject(new Error("Discord said no"));
    expect(await firstOutcome).toBe("Discord said no");
    await vi.waitFor(() => expect(puts).toHaveLength(2));
    expect(kickPermission(puts[1])).toBeNull();
    puts[1].resolve();

    await expect(second).resolves.toBeUndefined();
  });

  it("a change made while the follow-up is out gets another follow-up", async () => {
    const bot = makeBot();

    const first = bot.registerCommands();
    bot.commandPermissions.kick = "admin";
    const second = bot.registerCommands();
    puts[0].resolve();
    await first;
    await vi.waitFor(() => expect(puts).toHaveLength(2));

    bot.commandPermissions.kick = "everyone";
    const third = bot.registerCommands();
    await Promise.resolve();
    expect(puts).toHaveLength(2);

    puts[1].resolve();
    await second;
    await vi.waitFor(() => expect(puts).toHaveLength(3));
    expect(kickPermission(puts[2])).toBeNull();
    puts[2].resolve();
    await third;
  });

  it("skips the follow-up quietly when the bot was stopped meanwhile", async () => {
    const bot = makeBot();

    const first = bot.registerCommands();
    const second = bot.registerCommands();
    bot.client = null;

    puts[0].resolve();
    await first;
    await expect(second).resolves.toBeUndefined();
    expect(puts).toHaveLength(1);
  });

  it("a call with nothing in flight registers right away, and leaves no follow-up behind", async () => {
    const bot = makeBot();

    const first = bot.registerCommands();
    puts[0].resolve();
    await first;

    const again = bot.registerCommands();
    expect(puts).toHaveLength(2);
    puts[1].resolve();
    await again;

    expect(bot._registerInFlight).toBeNull();
    expect(bot._registerFollowUp).toBeNull();
  });
});
