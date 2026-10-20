import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  init,
  startApp,
  tokenWithCapabilities,
} from "./helpers/authzHarness.js";

// SECURITY (2026-10-20, access-control audit): servers.manage alone could
// point a server's RCON host at a listener it runs, and GET
// /api/servers/rcon-status (any signed-in role) then sent the stored RCON
// password there. An RCON host/port/password change now needs
// server.configure, a new host or port needs the password entered again,
// and the probe is limited to servers.manage or rcon.execute. Also: an edit
// that only resends the record no longer reconnects the active server's
// RCON, and the reconnect warning carries a code.

const { default: serversRouter } = await import("../routes/servers.js");
const { default: rconRouter } = await import("../routes/rcon.js");

const SECRET = "Stored-Rcon-Secret-42";

const captured = [];
const evil = net.createServer((socket) => {
  socket.on("data", (buf) => {
    // Source RCON packet: int32 size, int32 id, int32 type, body\0\0
    if (buf.length >= 14) captured.push(buf.subarray(12, buf.length - 2).toString("utf8"));
  });
});

const rconCalls = { connect: 0, disconnect: 0, reload: 0 };
let connectResult = true;
const rconService = {
  isConnected: () => true,
  disconnect: async () => {
    rconCalls.disconnect += 1;
  },
  reloadConfig: async () => {
    rconCalls.reload += 1;
  },
  connect: async () => {
    rconCalls.connect += 1;
    return connectResult;
  },
};

let app;
let evilPort;
let fleetOnly;
let fleetConfigure;
let noRcon;
let discoverOnly;

async function makeServer(overrides = {}) {
  return init.createServer({
    name: `Prod ${Math.random().toString(36).slice(2, 8)}`,
    serverName: "servertest",
    installPath: "C:/nonexistent/pz",
    zomboidDataPath: null,
    rconHost: "127.0.0.1",
    rconPort: 27015,
    rconPassword: SECRET,
    isRemote: true,
    ...overrides,
  });
}

beforeAll(async () => {
  await new Promise((resolve) => evil.listen(0, "127.0.0.1", resolve));
  evilPort = evil.address().port;
  fleetOnly = await tokenWithCapabilities(["servers.manage"]);
  fleetConfigure = await tokenWithCapabilities(["servers.manage", "server.configure"]);
  noRcon = await tokenWithCapabilities(["players.view"]);
  discoverOnly = await tokenWithCapabilities(["servers.manage", "servers.discover"]);
  app = await startApp([["/api/servers", serversRouter]], {
    serverManager: { reloadConfig: async () => {} },
    rconService,
  });
});

afterAll(async () => {
  await app?.close();
  await new Promise((resolve) => evil.close(resolve));
});

describe("PUT /api/servers/:id -- RCON connection changes", () => {
  it("refuses servers.manage alone pointing RCON at another host, and the stored password never reaches it", async () => {
    const server = await makeServer();
    const res = await app.call("PUT", `/api/servers/${server.id}`, fleetOnly, {
      rconHost: "127.0.0.1",
      rconPort: evilPort,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SERVER_RCON_CHANGE_REQUIRES_CONFIGURE");
    const stored = await init.getServer(server.id);
    expect(stored.rconPort).toBe(27015);

    const probe = await app.call("GET", "/api/servers/rcon-status", fleetOnly);
    expect(probe.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(captured).toEqual([]);
  });

  it("refuses a host change alone and a password change alone without server.configure", async () => {
    const server = await makeServer();
    const host = await app.call("PUT", `/api/servers/${server.id}`, fleetOnly, {
      rconHost: "attacker.example",
      rconPassword: "guess-1234",
    });
    expect(host.status).toBe(403);
    const pw = await app.call("PUT", `/api/servers/${server.id}`, fleetOnly, {
      rconPassword: "new-password-1",
    });
    expect(pw.status).toBe(403);
    expect((await init.getServer(server.id)).rconPassword).toBe(SECRET);
  });

  it("still lets servers.manage save the whole record back unchanged (masked password, same host and port)", async () => {
    const server = await makeServer();
    const res = await app.call("PUT", `/api/servers/${server.id}`, fleetOnly, {
      name: "Renamed",
      rconHost: " 127.0.0.1 ",
      rconPort: "27015",
      rconPassword: "••••••••",
    });
    expect(res.status).toBe(200);
    const stored = await init.getServer(server.id);
    expect(stored.name).toBe("Renamed");
    expect(stored.rconPassword).toBe(SECRET);
  });

  it("with server.configure, a new host or port needs the password entered again (the masked echo does not count)", async () => {
    const server = await makeServer();
    for (const body of [
      { rconPort: evilPort },
      { rconHost: "LOCALHOST", rconPassword: "••••••••" },
    ]) {
      const res = await app.call("PUT", `/api/servers/${server.id}`, fleetConfigure, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SERVER_RCON_PASSWORD_REQUIRED_FOR_NEW_TARGET");
    }
    const ok = await app.call("PUT", `/api/servers/${server.id}`, fleetConfigure, {
      rconHost: "127.0.0.1",
      rconPort: 27016,
      rconPassword: "Brand-new-secret-7",
    });
    expect(ok.status).toBe(200);
    const stored = await init.getServer(server.id);
    expect(stored.rconPort).toBe(27016);
    expect(stored.rconPassword).toBe("Brand-new-secret-7");
  });
});

describe("PUT /api/servers/:id -- the active server's RCON reconnect", () => {
  it("does not reconnect RCON when the dialog only resends the stored connection", async () => {
    const server = await makeServer();
    await init.setActiveServer(server.id);
    rconCalls.connect = 0;
    const res = await app.call("PUT", `/api/servers/${server.id}`, fleetOnly, {
      name: "Active rename",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "••••••••",
    });
    expect(res.status).toBe(200);
    expect(rconCalls.connect).toBe(0);
    expect(res.body.warnings).toBeUndefined();
  });

  it("reconnects on a real change and codes the warning when that fails", async () => {
    const server = await makeServer();
    await init.setActiveServer(server.id);
    rconCalls.connect = 0;
    connectResult = false;
    try {
      const res = await app.call("PUT", `/api/servers/${server.id}`, fleetConfigure, {
        rconPassword: "Another-secret-8",
      });
      expect(res.status).toBe(200);
      expect(rconCalls.connect).toBe(1);
      expect(res.body.warningDetails).toEqual([
        expect.objectContaining({ code: "SERVER_RCON_RECONNECT_FAILED" }),
      ]);
      expect(res.body.warnings).toHaveLength(1);
    } finally {
      connectResult = true;
    }
  });
});

describe("GET /api/servers/rcon-status", () => {
  it("is refused to a role without servers.manage or rcon.execute", async () => {
    const res = await app.call("GET", "/api/servers/rcon-status", noRcon);
    expect(res.status).toBe(403);
  });

  it("answers rcon.execute", async () => {
    const token = await tokenWithCapabilities(["rcon.execute"]);
    const res = await app.call("GET", "/api/servers/rcon-status", token);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/rcon/connect with a target override (adversary pass)", () => {
  // The other door to the same connection: overriding host/port without a
  // password kept the stored one (updateConfig()) and sent it there.
  let rconApp;
  const updates = [];
  beforeAll(async () => {
    rconApp = await startApp([["/api/rcon", rconRouter]], {
      rconService: {
        updateConfig: (...args) => updates.push(args),
        connect: async () => false,
        getConfig: () => ({ host: "127.0.0.1", port: evilPort }),
        getUserFriendlyError: (m) => m,
      },
    });
  });
  afterAll(async () => {
    await rconApp?.close();
  });

  it("refuses rcon.execute + servers.manage without server.configure", async () => {
    const token = await tokenWithCapabilities(["rcon.execute", "servers.manage"]);
    const res = await rconApp.call("POST", "/api/rcon/connect", token, { host: "127.0.0.1", port: evilPort });
    expect(res.status).toBe(403);
    expect(updates).toEqual([]);
  });

  it("refuses a new host or port without a password, even with server.configure", async () => {
    const token = await tokenWithCapabilities(["rcon.execute", "servers.manage", "server.configure"]);
    const res = await rconApp.call("POST", "/api/rcon/connect", token, { host: "127.0.0.1", port: evilPort });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SERVER_RCON_PASSWORD_REQUIRED_FOR_NEW_TARGET");
    expect(updates).toEqual([]);
  });

  it("still reconnects to the configured target with no override", async () => {
    const token = await tokenWithCapabilities(["rcon.execute"]);
    const res = await rconApp.call("POST", "/api/rcon/connect", token, {});
    expect(res.status).toBe(503);
    expect(updates).toEqual([]);
  });
});

describe("POST /api/servers -- importIniFrom (adversary pass)", () => {
  it("does not let servers.manage + servers.discover send an imported ini's RCON password to a host of its choosing", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rcon-import-"));
    fs.mkdirSync(path.join(dataDir, "Server"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "Server", "imported.ini"), "RCONPassword=ini-secret-99\nRCONPort=27015\n");
    try {
      const res = await app.call("POST", "/api/servers", discoverOnly, {
        name: "Imported",
        installPath: "C:/nonexistent/pz2",
        rconHost: "attacker.example",
        rconPort: 27015,
        importIniFrom: { dataPath: dataDir, serverName: "imported" },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("SERVER_RCON_CHANGE_REQUIRES_CONFIGURE");

      const local = await app.call("POST", "/api/servers", discoverOnly, {
        name: "Imported local",
        installPath: "C:/nonexistent/pz2",
        rconHost: "127.0.0.1",
        rconPort: 27015,
        importIniFrom: { dataPath: dataDir, serverName: "imported" },
      });
      expect(local.body?.code).not.toBe("SERVER_RCON_CHANGE_REQUIRES_CONFIGURE");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
