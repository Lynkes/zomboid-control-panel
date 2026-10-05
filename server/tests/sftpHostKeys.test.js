import { beforeEach, describe, expect, it, vi } from "vitest";

// security audit M3: outbound SFTP connections had no host-key verification
// at all (ssh2 accepts any key unless hostVerifier is supplied), so an
// on-path attacker could impersonate a remote server and harvest the stored
// SFTP password and bridge traffic. These pin the trust-on-first-use policy:
// first key is pinned, the same key is accepted later, a different key is
// refused, unknown store state fails closed -- and a changed key is only
// ever replaced by the exact fingerprint the operator approved.
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

const {
  verifyHostKey,
  trustHostKey,
  getHostKeyRefusal,
  listHostKeyRefusals,
  resetHostKeyRefusals,
  parseFingerprint,
  shortFingerprint,
  HostKeyTrustError,
  KNOWN_HOSTS_SETTING,
  REFUSAL_LOG_INTERVAL_MS,
} = await import("../services/sftpHostKeys.js");
const { classifySftpErrorCode, getSftpErrorGuidance } = await import("../services/panelBridgeSftp.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);
const pins = () => JSON.parse(state.settings.get(KNOWN_HOSTS_SETTING));

function reset() {
  state.settings.clear();
  state.failReads = false;
  resetHostKeyRefusals();
}

describe("sftpHostKeys — trust-on-first-use pinning", () => {
  const log = { warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    reset();
    log.warn.mockClear();
    log.error.mockClear();
  });

  it("pins the key on the first connection and accepts it", async () => {
    expect(await verifyHostKey("host.example", 2222, KEY_A, { log })).toBe(true);
    expect(pins()["host.example:2222"]).toBe(KEY_A);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("accepts the same key on later connections without re-pinning or warning", async () => {
    await verifyHostKey("host.example", 2222, KEY_A, { log });
    log.warn.mockClear();
    expect(await verifyHostKey("host.example", 2222, KEY_A, { log })).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("REFUSES a different key (possible MITM), logs both fingerprints and points to the real recovery path", async () => {
    await verifyHostKey("host.example", 2222, KEY_A, { log });
    expect(await verifyHostKey("host.example", 2222, KEY_B, { log })).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    const message = log.error.mock.calls[0][0];
    expect(message).toContain(shortFingerprint(KEY_A));
    expect(message).toContain(shortFingerprint(KEY_B));
    expect(message).toContain("Trust new host key");
    // sftpKnownHosts is not an editable setting: the log must not send the
    // operator there.
    expect(message).not.toContain(KNOWN_HOSTS_SETTING);
    // The stored pin is not overwritten by the refused key.
    expect(pins()["host.example:2222"]).toBe(KEY_A);
  });

  it("remembers the refused key so the UI can show what it would be trusting", async () => {
    await verifyHostKey("Host.Example", 2222, KEY_A, { log });
    await verifyHostKey("host.example", 2222, KEY_B, { log });
    expect(getHostKeyRefusal("HOST.example", "2222")).toMatchObject({
      host: "host.example",
      port: 2222,
      pinned: shortFingerprint(KEY_A),
      presented: shortFingerprint(KEY_B),
      reason: "mismatch",
      attempts: 1,
    });
    expect(listHostKeyRefusals()).toHaveLength(1);
  });

  it("logs a refused key at most once a minute per host and key, but at once for a new key", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    await verifyHostKey("host.example", 22, KEY_A, { log, now });
    // The bridge polls every 2-10 s and Files reconnects per request.
    for (let i = 0; i < 7; i += 1) {
      clock += 2_000;
      expect(await verifyHostKey("host.example", 22, KEY_B, { log, now })).toBe(false);
    }
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(getHostKeyRefusal("host.example", 22).attempts).toBe(7);

    clock += REFUSAL_LOG_INTERVAL_MS;
    await verifyHostKey("host.example", 22, KEY_B, { log, now });
    expect(log.error).toHaveBeenCalledTimes(2);

    // A different presented key is new information: logged straight away.
    clock += 1_000;
    await verifyHostKey("host.example", 22, KEY_C, { log, now });
    expect(log.error).toHaveBeenCalledTimes(3);
    expect(getHostKeyRefusal("host.example", 22).presented).toBe(shortFingerprint(KEY_C));
  });

  it("treats host case and a missing port as the same endpoint", async () => {
    await verifyHostKey("Host.Example", undefined, KEY_A, { log });
    expect(await verifyHostKey("host.example", 22, KEY_A, { log })).toBe(true);
  });

  it("keeps distinct pins per port", async () => {
    await verifyHostKey("host.example", 22, KEY_A, { log });
    expect(await verifyHostKey("host.example", 2222, KEY_B, { log })).toBe(true);
    expect(pins()["host.example:22"]).toBe(KEY_A);
    expect(pins()["host.example:2222"]).toBe(KEY_B);
  });

  it("does not lose a pin when two hosts connect for the first time at once", async () => {
    await Promise.all([
      verifyHostKey("one.example", 22, KEY_A, { log }),
      verifyHostKey("two.example", 22, KEY_B, { log }),
    ]);
    expect(pins()).toEqual({ "one.example:22": KEY_A, "two.example:22": KEY_B });
  });

  it("fails closed when the pin store cannot be read", async () => {
    state.failReads = true;
    expect(await verifyHostKey("host.example", 22, KEY_A, { log })).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  it("fails closed on a pin store that parses to something other than a host map", async () => {
    for (const raw of ["null", "[]", "42", '"x"', "true", "{not json"]) {
      reset();
      state.settings.set(KNOWN_HOSTS_SETTING, raw);
      expect(await verifyHostKey("victim.example", 22, KEY_C, { log })).toBe(false);
      // Not overwritten into a fresh "trust everything" store either.
      expect(state.settings.get(KNOWN_HOSTS_SETTING)).toBe(raw);
      expect(getHostKeyRefusal("victim.example", 22)).toMatchObject({
        pinned: null,
        presented: shortFingerprint(KEY_C),
        reason: "store-unreadable",
      });
    }
  });
});

describe("sftpHostKeys — trusting a changed key pins exactly the approved fingerprint", () => {
  beforeEach(reset);

  async function refuseB() {
    await verifyHostKey("host.example", 22, KEY_A);
    await verifyHostKey("other.example", 22, KEY_A);
    expect(await verifyHostKey("host.example", 22, KEY_B)).toBe(false);
  }

  it("pins the presented key, keeps other hosts' pins, and clears the refusal", async () => {
    await refuseB();
    const result = await trustHostKey("HOST.example", "22", shortFingerprint(KEY_B));
    expect(result).toEqual({
      host: "host.example",
      port: 22,
      fingerprint: shortFingerprint(KEY_B),
      previous: shortFingerprint(KEY_A),
    });
    expect(pins()).toEqual({ "host.example:22": KEY_B, "other.example:22": KEY_A });
    expect(getHostKeyRefusal("host.example", 22)).toBeNull();
    expect(await verifyHostKey("host.example", 22, KEY_B)).toBe(true);
  });

  it("leaves no trust-on-first-use window: a third key is still refused after the trust", async () => {
    await refuseB();
    await trustHostKey("host.example", 22, shortFingerprint(KEY_B));
    expect(await verifyHostKey("host.example", 22, KEY_C)).toBe(false);
    expect(pins()["host.example:22"]).toBe(KEY_B);
  });

  it("refuses to pin a fingerprint the host is not presenting (the key changed again)", async () => {
    await refuseB();
    // The operator approved B, but by now the host presents C.
    expect(await verifyHostKey("host.example", 22, KEY_C)).toBe(false);
    const error = await trustHostKey("host.example", 22, shortFingerprint(KEY_B)).catch((e) => e);
    expect(error).toBeInstanceOf(HostKeyTrustError);
    expect(error.code).toBe(ErrorCode.SFTP_HOST_KEY_NOT_PRESENTED);
    expect(error.status).toBe(409);
    expect(pins()["host.example:22"]).toBe(KEY_A);
  });

  it("refuses when no key is being refused for that host", async () => {
    await verifyHostKey("host.example", 22, KEY_A);
    const error = await trustHostKey("host.example", 22, shortFingerprint(KEY_B)).catch((e) => e);
    expect(error.code).toBe(ErrorCode.SFTP_HOST_KEY_NOT_PRESENTED);
    expect(pins()["host.example:22"]).toBe(KEY_A);
  });

  it("rejects something that is not a SHA256 fingerprint", async () => {
    await refuseB();
    for (const bad of [undefined, "", "SHA256:short", "MD5:aa:bb", "z".repeat(64)]) {
      const error = await trustHostKey("host.example", 22, bad).catch((e) => e);
      expect(error.status).toBe(400);
    }
    expect(pins()["host.example:22"]).toBe(KEY_A);
  });

  it("resets a corrupt pin store to the one approved key instead of leaving every host refused", async () => {
    state.settings.set(KNOWN_HOSTS_SETTING, "{not json");
    expect(await verifyHostKey("host.example", 22, KEY_A)).toBe(false);
    expect(await trustHostKey("host.example", 22, shortFingerprint(KEY_A))).toMatchObject({
      storeReset: true,
      previous: null,
    });
    expect(pins()).toEqual({ "host.example:22": KEY_A });
    expect(await verifyHostKey("host.example", 22, KEY_A)).toBe(true);
  });

  it("parseFingerprint() reads the displayed SHA256 form and plain hex", () => {
    expect(parseFingerprint(shortFingerprint(KEY_B))).toBe(KEY_B);
    expect(parseFingerprint(`${shortFingerprint(KEY_B)}=`)).toBe(KEY_B);
    expect(parseFingerprint(KEY_B.toUpperCase())).toBe(KEY_B);
    expect(parseFingerprint("SHA256:abc")).toBeNull();
  });

  it("a refused host key is classified as SFTP_HOST_KEY_MISMATCH, not a generic failure", () => {
    // ssh2's exact message when hostVerifier refuses (lib/protocol/kex.js).
    const error = new Error("Host denied (verification failed)");
    expect(classifySftpErrorCode(error)).toBe("SFTP_HOST_KEY_MISMATCH");
    expect(getSftpErrorGuidance(error)).toMatch(/Trust new host key/);
    // A bad signature is a different failure and must not be offered the
    // "trust the new key" path.
    expect(classifySftpErrorCode(new Error("Handshake failed: signature verification failed"))).not.toBe(
      "SFTP_HOST_KEY_MISMATCH",
    );
  });
});
