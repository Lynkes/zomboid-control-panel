import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import net from "net";

// god-dispatched continuous-bug-hunt, round 8: SourceRconClient.execute()
// rejects for two genuinely different reasons that used to be
// indistinguishable to every caller -- (a) the socket.write() callback
// itself reported an error (EPIPE, ECONNRESET on the write, "write after
// end", ...), meaning these exact bytes never left this process; vs (b) the
// write succeeded but the connection then dropped, or the command simply
// timed out, before a response came back -- genuinely ambiguous, the server
// may well have received and processed it. server/services/rcon.js's
// execute()/quit() treat "commandSent" as license to optimistically report
// a connection-reset quit as "server shutting down" -- correct for (b), but
// wrong for (a): nothing was ever transmitted. This proves the ONE place
// that can tell the two apart for certain -- the write() callback -- tags
// its error with `.rconNeverSent = true` so callers can make that
// distinction.

const { warnCalls, mockLogger } = vi.hoisted(() => {
  const warnCalls = [];
  return {
    warnCalls,
    mockLogger: {
      info: () => {},
      warn: (msg) => warnCalls.push(msg),
      error: () => {},
      debug: () => {},
    },
  };
});

vi.mock("../utils/logger.js", () => ({
  createLogger: () => mockLogger,
}));

const { SourceRconClient } = await import("../utils/sourceRcon.js");

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(body ?? "", "utf8");
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const buf = Buffer.alloc(4 + size);
  let offset = 0;
  buf.writeInt32LE(size, offset); offset += 4;
  buf.writeInt32LE(id, offset); offset += 4;
  buf.writeInt32LE(type, offset); offset += 4;
  bodyBuf.copy(buf, offset); offset += bodyBuf.length;
  buf.writeUInt8(0, offset); offset += 1;
  buf.writeUInt8(0, offset); offset += 1;
  return buf;
}

// Only needs to answer auth -- the EXECCOMMAND itself is never expected to
// arrive on the wire in the test below (that's the whole point: the write
// callback error means it never left the client).
function startAuthOnlyServer() {
  return new Promise((resolveServer) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 4) break;
          const size = buf.readInt32LE(0);
          const totalLen = 4 + size;
          if (buf.length < totalLen) break;
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          buf = buf.subarray(totalLen);
          if (type === TYPE_AUTH) {
            socket.write(encodePacket(id, TYPE_AUTH_RESPONSE, ""));
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

describe("SourceRconClient.execute(): a write() callback failure is tagged as a definite non-send", () => {
  let server;
  let client;

  beforeEach(() => {
    warnCalls.length = 0;
  });

  afterEach(async () => {
    if (client) client.disconnect();
    if (server) await new Promise((r) => server.close(r));
    server = null;
    client = null;
  });

  it("rejects with rconNeverSent:true when socket.write()'s own callback reports an error", async () => {
    server = await startAuthOnlyServer();
    client = new SourceRconClient({ host: "127.0.0.1", port: server.address().port, timeout: 3000 });
    await client.authenticate("pw");

    // Force the exact failure mode this test targets: the write() call
    // itself fails, deterministically, without depending on OS-level EPIPE
    // timing. `this.connected` (checked at the top of execute()) reads off
    // `this.socket`/`.destroyed`, which this leaves untouched -- only the
    // write path is overridden, matching a real EPIPE's shape (the socket
    // object still exists; the specific write to it failed).
    const originalWrite = client.socket.write.bind(client.socket);
    client.socket.write = (data, cb) => {
      queueMicrotask(() => cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
      return false;
    };

    try {
      await expect(client.execute("save")).rejects.toMatchObject({
        code: "EPIPE",
        rconNeverSent: true,
      });
    } finally {
      client.socket.write = originalWrite;
    }
  });

  it("does NOT tag a normal timeout (write succeeded, no response arrived) as never-sent", async () => {
    server = await startAuthOnlyServer();
    client = new SourceRconClient({ host: "127.0.0.1", port: server.address().port, timeout: 3000 });
    await client.authenticate("pw");

    // The fake server above never answers EXECCOMMAND at all, so this always
    // times out -- a genuinely ambiguous "did it arrive" case, which must
    // stay unmarked (undefined, not true) so callers keep today's optimistic
    // handling for it.
    let caught;
    try {
      await client.execute("save", { timeoutMs: 20 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/timed out/i);
    expect(caught.rconNeverSent).toBeUndefined();
  });
});
