import { beforeEach, describe, expect, it, vi } from "vitest";

// security audit M3: outbound SFTP connections had no host-key verification
// at all (ssh2 accepts any key unless hostVerifier is supplied), so an
// on-path attacker could impersonate a remote server and harvest the stored
// SFTP password and bridge traffic. These pin the trust-on-first-use policy:
// first key is pinned, the same key is accepted later, a different key is
// refused, unknown store state fails closed.
const state = vi.hoisted(() => ({ settings: new Map(), failReads: false }));

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => {
    if (state.failReads) throw new Error("db down");
    return state.settings.get(key) ?? null;
  },
  setSetting: async (key, value) => {
    state.settings.set(key, value);
  },
}));

const { verifyHostKey, shortFingerprint, KNOWN_HOSTS_SETTING } = await import(
  "../services/sftpHostKeys.js"
);

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("sftpHostKeys — trust-on-first-use pinning", () => {
  const log = { warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    state.settings.clear();
    state.failReads = false;
    log.warn.mockClear();
    log.error.mockClear();
  });

  it("pins the key on the first connection and accepts it", async () => {
    expect(await verifyHostKey("host.example", 2222, KEY_A, { log })).toBe(true);
    const pins = JSON.parse(state.settings.get(KNOWN_HOSTS_SETTING));
    expect(pins["host.example:2222"]).toBe(KEY_A);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("accepts the same key on later connections without re-pinning or warning", async () => {
    await verifyHostKey("host.example", 2222, KEY_A, { log });
    log.warn.mockClear();
    expect(await verifyHostKey("host.example", 2222, KEY_A, { log })).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("REFUSES a different key (possible MITM) and logs both fingerprints", async () => {
    await verifyHostKey("host.example", 2222, KEY_A, { log });
    expect(await verifyHostKey("host.example", 2222, KEY_B, { log })).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    const message = log.error.mock.calls[0][0];
    expect(message).toContain(shortFingerprint(KEY_A));
    expect(message).toContain(shortFingerprint(KEY_B));
    // The stored pin is not overwritten by the refused key.
    const pins = JSON.parse(state.settings.get(KNOWN_HOSTS_SETTING));
    expect(pins["host.example:2222"]).toBe(KEY_A);
  });

  it("treats host case and a missing port as the same endpoint", async () => {
    await verifyHostKey("Host.Example", undefined, KEY_A, { log });
    expect(await verifyHostKey("host.example", 22, KEY_A, { log })).toBe(true);
  });

  it("keeps distinct pins per port", async () => {
    await verifyHostKey("host.example", 22, KEY_A, { log });
    expect(await verifyHostKey("host.example", 2222, KEY_B, { log })).toBe(true);
    const pins = JSON.parse(state.settings.get(KNOWN_HOSTS_SETTING));
    expect(pins["host.example:22"]).toBe(KEY_A);
    expect(pins["host.example:2222"]).toBe(KEY_B);
  });

  it("fails closed when the pin store cannot be read", async () => {
    state.failReads = true;
    expect(await verifyHostKey("host.example", 22, KEY_A, { log })).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});
