import { beforeEach, describe, expect, it, vi } from "vitest";

// Discord /start had no remote-server refusal: POST /api/server/start refuses
// a remote server and Discord /restart refuses one that has no Docker path
// (isUnmanagedRemoteServer), but /start went on to serverManager.startServer(),
// which launches a LOCAL process from the remote server's settings.

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({ getActiveServer: (...args) => getActiveServer(...args) }));

vi.mock("../services/panelBridge.js", () => ({ default: { isModConnected: vi.fn(() => false) } }));

const runManagedLifecycle = vi.fn(async () => ({ handled: false }));
vi.mock("../services/managedContainer.js", () => ({
  resolveDockerHostSignal: vi.fn(),
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

const { DiscordBot } = await import("../services/discordBot.js");

function makeBot(overrides = {}) {
  const bot = Object.create(DiscordBot.prototype);
  bot.serverManager = {
    getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
    startServer: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
  bot.rconService = { connected: false };
  bot.sendNotification = vi.fn(async () => true);
  return bot;
}

function makeInteraction() {
  const replies = [];
  return {
    replies,
    deferReply: async () => {},
    editReply: async (m) => replies.push(m),
    user: { tag: "someone#0001" },
  };
}

beforeEach(() => {
  getActiveServer.mockReset();
  runManagedLifecycle.mockClear();
});

describe("Discord /start on a remote server", () => {
  it("refuses before checking whether it runs, and never launches a local process", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true });
    const bot = makeBot();
    const interaction = makeInteraction();

    await bot.handleStart(interaction);

    expect(interaction.replies).toHaveLength(1);
    expect(interaction.replies[0]).toMatch(/cannot start a remote server/i);
    expect(bot.serverManager.getServerProcessDetails).not.toHaveBeenCalled();
    expect(bot.serverManager.startServer).not.toHaveBeenCalled();
    expect(runManagedLifecycle).not.toHaveBeenCalled();
    expect(bot.sendNotification).not.toHaveBeenCalled();
  });

  it("still starts a remote server that has a Docker container mapped to it", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: true, dockerContainerName: "pz-server" });
    runManagedLifecycle.mockResolvedValueOnce({ handled: true, success: true });
    const bot = makeBot();
    const interaction = makeInteraction();

    await bot.handleStart(interaction);

    expect(interaction.replies[0]).toMatch(/starting/i);
    expect(runManagedLifecycle).toHaveBeenCalledWith("start", expect.anything());
  });

  it("still starts a local server", async () => {
    getActiveServer.mockResolvedValue({ id: "s1", isRemote: false });
    const bot = makeBot();
    const interaction = makeInteraction();

    await bot.handleStart(interaction);

    expect(bot.serverManager.startServer).toHaveBeenCalled();
    expect(interaction.replies[0]).toMatch(/starting/i);
  });
});
