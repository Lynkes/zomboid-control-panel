import { afterEach, describe, expect, it } from "vitest";
import crypto from "crypto";
import { createRequire } from "module";

// SFTP host-key pinning end to end: a real ssh2 server whose host key is
// swapped between connections, the panel's real SFTP client and pin store
// (this file's own temp database), and the real PanelBridge route handlers.
//
// What the operator gets after a refused key: the refusal with BOTH
// fingerprints, from the route that failed and from /status (so it shows
// even when the bridge is not running), and a trust action that pins exactly
// the key they compared. Before, "Trust new host key" forgot the pin and the
// next connection -- from anyone -- pinned whatever key it saw.
const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");

const router = (await import("../routes/panelBridge.js")).default;
const { getSetting } = await import("../database/init.js");
const { KNOWN_HOSTS_SETTING, shortFingerprint, resetHostKeyRefusals } = await import(
  "../services/sftpHostKeys.js"
);
const { ErrorCode } = await import("../utils/errorCodes.js");

function generateHostKey() {
  for (let i = 0; i < 20; i += 1) {
    const key = utils.generateKeyPairSync("ed25519").private;
    const parsed = utils.parseKey(key);
    if (!(parsed instanceof Error)) {
      const hex = crypto.createHash("sha256").update(parsed.getPublicSSH()).digest("hex");
      return { key, hex, display: shortFingerprint(hex) };
    }
  }
  throw new Error("could not generate an ed25519 host key");
}

// Answers the key exchange with `hostKey`, then rejects every login: only
// the host-key stage matters here, and the password attempts it records
// show whether the panel ever sent credentials to that key.
function startServer(hostKey, port = 0) {
  const passwords = [];
  const server = new Server({ hostKeys: [hostKey.key] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password") passwords.push(ctx.password);
      ctx.reject(["password"]);
    });
    client.on("error", () => {});
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, passwords, port: server.address().port }),
    ),
  );
}

function handler(method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(method, path, body) {
  const res = { statusCode: 200 };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  await handler(method, path)({ body, user: { username: "admin", role: "admin" } }, res);
  return res;
}

const servers = [];
async function serve(hostKey, port) {
  const running = await startServer(hostKey, port);
  servers.push(running);
  return running;
}
async function stopAll() {
  while (servers.length) {
    const { server } = servers.pop();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

afterEach(async () => {
  await stopAll();
  resetHostKeyRefusals();
});

const PASSWORD = "S3cret-sftp-pw";
const form = (port) => ({
  host: "127.0.0.1",
  port,
  username: "pzadmin",
  password: PASSWORD,
  bridgePath: "/srv/pz/Lua/panelbridge/Test",
});
const pinFor = async (port) =>
  JSON.parse((await getSetting(KNOWN_HOSTS_SETTING)) || "{}")[`127.0.0.1:${port}`];

describe("SFTP host-key refusal and trust through the PanelBridge routes", () => {
  it("shows both fingerprints, pins only the approved key, and keeps refusing any other", async () => {
    const keyA = generateHostKey();
    const keyB = generateHostKey();
    const keyC = generateHostKey();

    // First connection pins A (trust on first use; the login itself fails).
    const first = await serve(keyA);
    const port = first.port;
    const firstTest = await call("post", "/sftp/test", form(port));
    expect(firstTest.body.code).toBe(ErrorCode.SFTP_AUTH_FAILED);
    expect(await pinFor(port)).toBe(keyA.hex);
    await stopAll();

    // The host now presents B: refused before any password is sent, and the
    // response says which key it would be trusting.
    const second = await serve(keyB, port);
    const refused = await call("post", "/sftp/test", form(port));
    expect(refused.statusCode).toBe(400);
    expect(refused.body.code).toBe(ErrorCode.SFTP_HOST_KEY_MISMATCH);
    expect(refused.body.hostKey).toMatchObject({
      host: "127.0.0.1",
      port,
      pinned: keyA.display,
      presented: keyB.display,
    });
    expect(second.passwords).toEqual([]);

    // /status reports it too, with no bridge running.
    const status = await call("get", "/status");
    expect(status.body.hostKeyRefusals).toEqual([
      expect.objectContaining({ host: "127.0.0.1", port, pinned: keyA.display, presented: keyB.display }),
    ]);

    // Approving any other key than the one presented changes nothing.
    const wrong = await call("post", "/sftp/trust-host-key", {
      host: "127.0.0.1",
      port,
      fingerprint: keyC.display,
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.body.code).toBe(ErrorCode.SFTP_HOST_KEY_NOT_PRESENTED);
    expect(await pinFor(port)).toBe(keyA.hex);

    // Approving the presented key pins exactly that key.
    const trusted = await call("post", "/sftp/trust-host-key", {
      host: "127.0.0.1",
      port: String(port),
      fingerprint: keyB.display,
    });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.body).toMatchObject({ success: true, fingerprint: keyB.display, previous: keyA.display });
    expect(await pinFor(port)).toBe(keyB.hex);
    expect((await call("get", "/status")).body.hostKeyRefusals).toEqual([]);

    // B is accepted now (the connection reaches the login)...
    const afterTrust = await call("post", "/sftp/test", form(port));
    expect(afterTrust.body.code).toBe(ErrorCode.SFTP_AUTH_FAILED);
    expect(second.passwords.length).toBeGreaterThan(0);
    await stopAll();

    // ...and a third key is refused like the second was: trusting B opened
    // no window for whatever key comes next.
    const third = await serve(keyC, port);
    const again = await call("post", "/sftp/test", form(port));
    expect(again.body.code).toBe(ErrorCode.SFTP_HOST_KEY_MISMATCH);
    expect(again.body.hostKey.presented).toBe(keyC.display);
    expect(third.passwords).toEqual([]);
    expect(await pinFor(port)).toBe(keyB.hex);
  });

  it("the remote log viewer reports a refused key with the same code and fingerprints", async () => {
    const keyA = generateHostKey();
    const keyB = generateHostKey();
    const first = await serve(keyA);
    const port = first.port;
    await call("post", "/sftp/test", form(port));
    await stopAll();

    await serve(keyB, port);
    const res = await call("post", "/sftp/logs/list", {
      host: "127.0.0.1",
      port,
      username: "pzadmin",
      password: PASSWORD,
      logPath: "/srv/pz/Zomboid/Logs",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe(ErrorCode.SFTP_HOST_KEY_MISMATCH);
    expect(res.body.hostKey).toMatchObject({ pinned: keyA.display, presented: keyB.display });
  });
});
