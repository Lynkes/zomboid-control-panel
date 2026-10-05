// A stand-in for discord.js's Client, for tests that drive the real
// DiscordBot.start(): it records the listeners start() attaches, and login()
// finishes only when the test says so (finishLogin()), or on its own when
// FakeDiscordClient.autoReady is set. Finishing sets client.user and fires
// the clientReady listener, as a real gateway handshake does.
//
//   vi.mock("discord.js", async (importOriginal) => {
//     const actual = await importOriginal();
//     const { FakeDiscordClient } = await import("./helpers/fakeDiscordClient.js");
//     return { ...actual, Client: FakeDiscordClient };
//   });
//
// Stub the bot's registerCommands() and _startPresenceUpdates() on the
// instance: the first talks to Discord's REST API, the second starts a timer.
export const fakeDiscordClients = [];

export class FakeDiscordClient {
  static autoReady = true;

  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.onceListeners = new Map();
    this.user = null;
    this.loginToken = null;
    this.destroyed = false;
    this.finishLogin = null;
    fakeDiscordClients.push(this);
  }

  on(event, listener) {
    this.listeners.set(event, listener);
    return this;
  }

  once(event, listener) {
    this.onceListeners.set(event, listener);
    return this;
  }

  login(token) {
    this.loginToken = token;
    return new Promise((resolve) => {
      this.finishLogin = () => {
        this.user = { id: "900000000000000001", tag: "PanelBot#0001" };
        resolve(token);
        const ready = this.onceListeners.get("clientReady");
        this.onceListeners.delete("clientReady");
        ready?.();
      };
      if (FakeDiscordClient.autoReady) queueMicrotask(() => this.finishLogin());
    });
  }

  async destroy() {
    this.destroyed = true;
  }
}
