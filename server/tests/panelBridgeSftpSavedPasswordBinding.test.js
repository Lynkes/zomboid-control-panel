import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "module";

// SECURITY (2026-10-20): the saved PanelBridge SFTP password is used only
// with the saved host, port and username. Every SFTP route used to put it in
// for whatever host the request named when the request carried no password
// (or the mask the Settings page shows), so a bridge.setup role, which never
// sees the password, could have the panel log in to a host of its choice
// with it. A real ssh2 server records every password it is offered.
const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");

const router = (await import("../routes/panelBridge.js")).default;
const { setSetting } = await import("../database/init.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { resetHostKeyRefusals } = await import("../services/sftpHostKeys.js");
const { sftpPasswordForRequest, sftpTargetOf, sameSftpTarget } = await import(
  "../utils/sftpSavedTarget.js"
);

const SAVED_PASSWORD = "REAL-STORED-SFTP-PASSWORD";
const MASK = "••••••••";

let ssh;
const offered = [];
beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  ssh = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password") offered.push({ user: ctx.username, password: ctx.password });
      ctx.reject(["password"]);
    });
    client.on("error", () => {});
  });
  await new Promise((resolve) => ssh.listen(0, "127.0.0.1", resolve));
});
afterAll(async () => {
  await new Promise((resolve) => ssh.close(() => resolve()));
});

const port = () => ssh.address().port;

async function saveSettings({ host, sshPort, username }) {
  await setSetting("panelBridgeSftpPassword", SAVED_PASSWORD);
  await setSetting("panelBridgeSftpHost", host);
  await setSetting("panelBridgeSftpPort", sshPort);
  await setSetting("panelBridgeSftpUsername", username);
  await setSetting("panelBridgeSftpBridgePath", "/srv/pz/Lua/panelbridge/Test");
  await setSetting("panelBridgeSftpLogPath", "/srv/pz/Zomboid/Logs");
  await setSetting("panelBridgeSftpConfigPath", "/srv/pz/Zomboid/Server");
}

beforeEach(() => {
  offered.length = 0;
  resetHostKeyRefusals();
});

function handler(path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function post(path, body) {
  const res = { statusCode: 200 };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  await handler(path)({ body, user: { username: "tech", role: "technician" } }, res);
  return res;
}

const ROUTES = [
  ["/sftp/test", {}],
  ["/sftp/configure", {}],
  ["/sftp/logs/list", {}],
  ["/sftp/logs/tail", { name: "server.txt" }],
  ["/sftp/config/list", {}],
];

describe("the saved SFTP password goes only to the saved target", () => {
  describe.each(ROUTES)("%s", (path, extra) => {
    it.each([
      ["no password", undefined],
      ["an empty password", ""],
      ["the mask", MASK],
      ["an all-asterisk mask", "********"],
    ])("refuses another host with %s, and offers it nothing", async (_label, password) => {
      await saveSettings({ host: "game-host.internal", sshPort: 22, username: "pz" });
      const body = { host: "127.0.0.1", port: port(), username: "root", ...extra };
      if (password !== undefined) body.password = password;
      const res = await post(path, body);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe(ErrorCode.SFTP_PASSWORD_REQUIRED);
      expect(offered).toEqual([]);
    });

    it("refuses the saved host on another port or as another user", async () => {
      await saveSettings({ host: "127.0.0.1", sshPort: 2222, username: "pz" });
      const otherPort = await post(path, { port: port(), ...extra });
      expect(otherPort.body.code).toBe(ErrorCode.SFTP_PASSWORD_REQUIRED);
      await saveSettings({ host: "127.0.0.1", sshPort: port(), username: "pz" });
      const otherUser = await post(path, { username: "root", password: MASK, ...extra });
      expect(otherUser.body.code).toBe(ErrorCode.SFTP_PASSWORD_REQUIRED);
      const userCase = await post(path, { username: "PZ", ...extra });
      expect(userCase.body.code).toBe(ErrorCode.SFTP_PASSWORD_REQUIRED);
      expect(offered).toEqual([]);
    });

    it("uses the saved password with the saved target, however the form spells it", async () => {
      await saveSettings({ host: "127.0.0.1", sshPort: port(), username: "pz" });
      // Fields left out fall back to the saved ones.
      await post(path, { ...extra });
      // The form's own copy: blanks around host and user, the port as text,
      // the mask in the password field.
      await post(path, {
        host: " 127.0.0.1 ",
        port: String(port()),
        username: " pz ",
        password: MASK,
        ...extra,
      });
      expect(offered).toEqual([
        { user: "pz", password: SAVED_PASSWORD },
        { user: "pz", password: SAVED_PASSWORD },
      ]);
    });

    it("sends a password the request brings to the host it names", async () => {
      await saveSettings({ host: "game-host.internal", sshPort: 22, username: "pz" });
      const res = await post(path, {
        host: "127.0.0.1",
        port: port(),
        username: "root",
        password: "typed-for-this-host",
        ...extra,
      });
      expect(res.body.code).not.toBe(ErrorCode.SFTP_PASSWORD_REQUIRED);
      expect(offered).toEqual([{ user: "root", password: "typed-for-this-host" }]);
    });
  });
});

describe("sftpPasswordForRequest", () => {
  const saved = { host: "Game-Host.internal", port: 22, username: "pz", password: "secret" };

  it("treats case and blanks around the host as the same host", () => {
    for (const host of ["game-host.internal", "GAME-HOST.INTERNAL", "  game-host.internal\t", undefined]) {
      expect(sftpPasswordForRequest({ host, port: "22", username: "pz " }, saved)).toBe("secret");
    }
  });

  it("refuses look-alike hosts", () => {
    for (const host of [
      "game-host.internal.",
      "game-host.internal.evil.example",
      "evil.example",
      "game-host",
      "",
      ["game-host.internal"],
      { toString: () => "game-host.internal" },
    ]) {
      expect(() => sftpPasswordForRequest({ host, port: 22, username: "pz" }, saved)).toThrow(
        expect.objectContaining({ code: ErrorCode.SFTP_PASSWORD_REQUIRED }),
      );
    }
  });

  it("refuses a port that is not the saved one, or not a port at all", () => {
    for (const port of [2222, "2222", "abc", 22.5, -22]) {
      expect(() => sftpPasswordForRequest({ host: "game-host.internal", port, username: "pz" }, saved)).toThrow(
        expect.objectContaining({ code: ErrorCode.SFTP_PASSWORD_REQUIRED }),
      );
    }
  });

  it("needs nothing when no password is saved, and never refuses a typed one", () => {
    expect(sftpPasswordForRequest({ host: "evil.example" }, { ...saved, password: "" })).toBe("");
    expect(sftpPasswordForRequest({ host: "evil.example", password: "typed" }, saved)).toBe("typed");
  });

  it("a saved target with no host matches nothing", () => {
    expect(sameSftpTarget(sftpTargetOf("", 22, "pz"), sftpTargetOf("", 22, "pz"))).toBe(false);
  });
});
