import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Security sweep 2026-10-05, A1 (round 1 of the verification): the Steam
// Sync browser extension signs in to the panel with a password too, but it
// never kept or sent the trusted-device token the panel hands back, so its
// sign-ins were still counted by address -- refused while a stranger keeps
// a full throttle table's overflow entry, or an address the extension
// shares, paused. It now keeps one per panel and username and sends it, the
// same as the panel's own login page (client/src/lib/trustedDevice.ts).
//
// popup.js is a plain browser script, so it runs here in a vm context with
// just enough of the WebExtensions API and the DOM stubbed out.

const POPUP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../browser-extension/popup.js",
);

function loadPopup() {
  const storage = {};
  const element = () => ({ value: "", checked: false, disabled: false, addEventListener() {} });
  const responses = [];
  const fetch = vi.fn(async () => {
    const body = responses.shift();
    return { ok: true, status: 200, json: async () => body };
  });
  const context = vm.createContext({
    chrome: {
      storage: {
        local: {
          get: (keys, done) =>
            done(Object.fromEntries([keys].flat().filter((key) => key in storage).map((key) => [key, structuredClone(storage[key])]))),
          set: (items, done) => {
            Object.assign(storage, structuredClone(items));
            done?.();
          },
          remove: (keys, done) => {
            for (const key of [keys].flat()) delete storage[key];
            done?.();
          },
        },
      },
      cookies: { get: (_details, done) => done(null) },
      permissions: { request: (_request, done) => done(true) },
    },
    document: { getElementById: element, addEventListener() {} },
    fetch,
  });
  vm.runInContext(fs.readFileSync(POPUP, "utf8"), context, { filename: POPUP });
  return {
    login: (panelUrl, username) => context.loginToPanel(panelUrl, username, "panel-password"),
    respondWith: (body) => responses.push(body),
    sentDeviceToken: (call) => JSON.parse(fetch.mock.calls[call][1].body).deviceToken,
    storage,
  };
}

let popup;
beforeEach(() => {
  popup = loadPopup();
});

describe("Steam Sync extension: trusted-device token", () => {
  it("keeps the token a sign-in returns and sends it with the next sign-in to that panel and username", async () => {
    popup.respondWith({ accessToken: "access-1", deviceToken: "device-1" });
    await expect(popup.login("http://garage:3001", "Admin")).resolves.toBe("access-1");
    expect(popup.sentDeviceToken(0)).toBeUndefined();

    popup.respondWith({ accessToken: "access-2", deviceToken: "device-2" });
    await popup.login("http://garage:3001", "admin");
    expect(popup.sentDeviceToken(1)).toBe("device-1");

    // The newest one replaces it.
    popup.respondWith({ accessToken: "access-3" });
    await popup.login("http://garage:3001", "admin");
    expect(popup.sentDeviceToken(2)).toBe("device-2");
  });

  it("never sends one panel's or account's token to another", async () => {
    popup.respondWith({ accessToken: "access-1", deviceToken: "device-garage-admin" });
    await popup.login("http://garage:3001", "admin");

    popup.respondWith({ accessToken: "access-2" });
    await popup.login("https://vps.example:3001", "admin");
    expect(popup.sentDeviceToken(1)).toBeUndefined();

    popup.respondWith({ accessToken: "access-3" });
    await popup.login("http://garage:3001", "mod");
    expect(popup.sentDeviceToken(2)).toBeUndefined();
  });

  it("keeps at most 10, and ignores what isn't a token", async () => {
    for (let i = 0; i < 12; i++) {
      popup.respondWith({ accessToken: `access-${i}`, deviceToken: i === 11 ? { not: "a token" } : `device-${i}` });
      await popup.login(`http://panel-${i}:3001`, "admin");
    }
    expect(Object.keys(popup.storage.deviceTokens)).toHaveLength(10);
    popup.respondWith({ accessToken: "access-again" });
    await popup.login("http://panel-10:3001", "admin");
    expect(popup.sentDeviceToken(12)).toBe("device-10");
  });
});
