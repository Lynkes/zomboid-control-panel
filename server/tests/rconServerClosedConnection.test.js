import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "net";
import { ErrorCode } from "../utils/errorCodes.js";

// Console / RCON audit (2026-10-12). When the game server closes the RCON
// socket on its side (a clean FIN, as `quit` and a restart do), sourceRcon.js
// rejects the pending command with "RCON connection closed".
// RconService.execute() decides what to do with a failure by substring
// ("ECONNRESET", "socket", ...) and that text matched none, so the dead client
// stayed in place with connected=true, the failure carried no code, and `quit`
// -- which the server answers by closing the socket without a reply -- came
// back success:false, so POST /stop could answer 502 while the server was in
// fact shutting down.

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
  logCommand: () => {},
}));

const { RconService } = await import("../services/rcon.js");
const { SourceRconClient } = await import("../utils/sourceRcon.js");

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

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;

// A fake RCON server. `onCommand(body)` returns the reply, or `null` to close
// the connection without replying (what PZ does for `quit`).
function startFakeServer(onCommand) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
          const total = 4 + buf.readInt32LE(0);
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.toString("utf8", 12, total - 2);
          buf = buf.subarray(total);
          if (type === TYPE_AUTH) {
            socket.write(encodePacket(id, TYPE_AUTH_RESPONSE, ""));
          } else if (type === TYPE_EXECCOMMAND) {
            const reply = onCommand(body);
            if (reply === null) socket.end();
            else socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, reply));
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("RconService: the game server closes the RCON socket", () => {
  let server;
  let service;

  beforeEach(async () => {
    server = await startFakeServer((body) => (body === "players" || body === "quit" ? null : `ok: ${body}`));
    const client = new SourceRconClient({ host: "127.0.0.1", port: server.address().port, timeout: 3000 });
    await client.authenticate("pw");
    service = new RconService();
    service.client = client;
    service.connected = true;
  });

  afterEach(async () => {
    service.client?.disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  it("quit counts as sent and the server as shutting down when the socket is closed without a reply", async () => {
    const result = await service.quit({ skipLog: true });

    expect(result).toEqual({ success: true, response: "Server shutting down" });
    expect(service.connected).toBe(false);
  });

  it("a command cut short that way is a disconnect: client dropped, flagged and coded", async () => {
    const result = await service.execute("players", { skipLog: true });

    expect(result.success).toBe(false);
    expect(result.transportError).toBe(true);
    expect(result.commandSent).toBe(true);
    expect(service.connected).toBe(false);
    expect(service.client).toBeNull();
    expect(service.getRconDisconnectCode("RCON connection closed")).toBe(ErrorCode.RCON_EXECUTE_DISCONNECTED);
    expect(service.getUserFriendlyError("RCON connection closed")).toMatch(/closed by the server/i);
  });
});
