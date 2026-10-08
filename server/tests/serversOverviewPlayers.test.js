import { afterEach, describe, expect, it } from "vitest";
import net from "net";
import { createServer as createServerRecord, deleteServer } from "../database/init.js";
import { parsePlayersResponse, testRconConnection } from "../services/rcon.js";

// The Dashboard's overview of every server counts each one's players over a
// one-off RCON connection (GET /servers/rcon-status?players=1): the panel's
// own connection reaches the active server only.

const { default: serversRouter } = await import("../routes/servers.js");

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(body ?? "", "utf8");
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

// A Source RCON server that takes any password and answers `players`.
function startFakeRcon(playersReply) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
          const total = 4 + buf.readInt32LE(0);
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.toString("utf8", 12, total - 2);
          buf = buf.subarray(total);
          if (type === TYPE_AUTH) socket.write(encodePacket(id, TYPE_AUTH_RESPONSE, ""));
          else if (type === TYPE_EXECCOMMAND) {
            socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, body === "players" ? playersReply : ""));
          }
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const TWO_PLAYERS = "Players connected (2):\n-Ana\n- Bob\n";

let fake = null;
const created = [];

afterEach(async () => {
  if (fake) await new Promise((r) => fake.close(r));
  fake = null;
  for (const id of created.splice(0)) await deleteServer(id).catch(() => {});
});

describe("parsePlayersResponse()", () => {
  it("lists each player line, keeping a name's own spaces", () => {
    expect(parsePlayersResponse(TWO_PLAYERS)).toEqual([
      { name: "Ana", online: true },
      { name: " Bob", online: true },
    ]);
    expect(parsePlayersResponse("Players connected (0):\n")).toEqual([]);
    expect(parsePlayersResponse("")).toEqual([]);
  });
});

describe("testRconConnection({ countPlayers })", () => {
  it("counts the players after logging in", async () => {
    fake = await startFakeRcon(TWO_PLAYERS);
    const result = await testRconConnection({
      host: "127.0.0.1", port: fake.address().port, password: "pw", timeoutMs: 2000, countPlayers: true,
    });
    expect(result).toMatchObject({ success: true, players: 2 });
  });

  it("asks for nothing more without it", async () => {
    fake = await startFakeRcon(TWO_PLAYERS);
    const result = await testRconConnection({
      host: "127.0.0.1", port: fake.address().port, password: "pw", timeoutMs: 2000,
    });
    expect(result).toEqual({ success: true, detail: "Connected" });
  });
});

describe("GET /servers/rcon-status", () => {
  const handler = (() => {
    const layer = serversRouter.stack.find(
      (entry) => entry.route?.path === "/rcon-status" && entry.route.methods.get,
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
  })();

  async function get(query) {
    let body = null;
    let statusCode = 200;
    const res = {
      status(code) { statusCode = code; return res; },
      json(payload) { body = payload; return res; },
    };
    await handler({ query, app: { get: () => undefined } }, res);
    return { statusCode, body };
  }

  it("adds each server's player count with ?players=1, and null for one that doesn't answer", async () => {
    fake = await startFakeRcon(TWO_PLAYERS);
    const up = await createServerRecord({
      name: "OverviewUp", serverName: "OverviewUp", rconHost: "127.0.0.1",
      rconPort: fake.address().port, rconPassword: "pw",
    });
    // Port 1: nothing answers there.
    const down = await createServerRecord({
      name: "OverviewDown", serverName: "OverviewDown", rconHost: "127.0.0.1", rconPort: 1, rconPassword: "pw",
    });
    created.push(up.id, down.id);

    const { statusCode, body } = await get({ players: "1" });

    expect(statusCode).toBe(200);
    const byId = Object.fromEntries(body.servers.map((row) => [String(row.id), row]));
    expect(byId[String(up.id)]).toEqual({ id: up.id, status: "connected", players: 2 });
    expect(byId[String(down.id)]).toMatchObject({ status: "unreachable", players: null });
  });

  it("leaves the count out without it, as My Servers asks", async () => {
    fake = await startFakeRcon(TWO_PLAYERS);
    const up = await createServerRecord({
      name: "OverviewPlain", serverName: "OverviewPlain", rconHost: "127.0.0.1",
      rconPort: fake.address().port, rconPassword: "pw",
    });
    created.push(up.id);

    const { body } = await get({});

    const row = body.servers.find((r) => String(r.id) === String(up.id));
    expect(row).toEqual({ id: up.id, status: "connected" });
  });
});
