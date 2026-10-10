import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import net from "net";

// The game cuts a reply longer than one packet (a body of 4086 bytes, the most
// a 4096-byte packet can carry) into several packets that share the command's
// request id, and sends nothing to mark the end (`showoptions` is ~4.9 KB).
// The client used to resolve on the first packet, so the Console showed a list
// cut at 4086 bytes and each remaining packet logged an "Orphaned RCON
// response" warning. A packet that filled the limit now keeps the command open
// for a short quiet window and later same-id packets are appended.

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
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;
const FULL = 4086; // largest body one packet carries

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "", "utf8");
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fake server whose reply to every EXECCOMMAND is the list of packet bodies
// `replyPackets(body)` returns (Buffers or strings), written back to back with
// the command's id. `afterReply(socket)` runs once they are written.
function startFakeServer({ replyPackets, afterReply = null }) {
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
          const body = buf.toString("utf8", 12, totalLen - 2);
          buf = buf.subarray(totalLen);

          if (type === TYPE_AUTH) {
            socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, ""));
            socket.write(encodePacket(id, TYPE_AUTH_RESPONSE, ""));
          } else if (type === TYPE_EXECCOMMAND) {
            for (const part of replyPackets(body)) {
              socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, part));
            }
            if (afterReply) afterReply(socket);
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

describe("SourceRconClient: a reply split across packets with the same id (real socket)", () => {
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

  async function connect(options) {
    server = await startFakeServer(options);
    client = new SourceRconClient({ host: "127.0.0.1", port: server.address().port, timeout: 3000 });
    await client.authenticate("pw");
  }

  it("returns the whole ~4.9 KB reply sent as 4086 bytes + the rest, with no orphan warning", async () => {
    const full = `${"a".repeat(FULL)}${"b".repeat(800)}`;
    await connect({ replyPackets: () => [full.slice(0, FULL), full.slice(FULL)] });

    const response = await client.execute("showoptions", { timeoutMs: 3000 });
    await sleep(50);

    expect(response.length).toBe(FULL + 800);
    expect(response).toBe(full);
    expect(warnCalls).toEqual([]);
  });

  it("joins three packets (two full ones and a short last one)", async () => {
    const parts = ["x".repeat(FULL), "y".repeat(FULL), "z".repeat(10)];
    await connect({ replyPackets: () => parts });

    const response = await client.execute("big", { timeoutMs: 3000 });

    expect(response).toBe(parts.join(""));
  });

  it("decodes a multi-byte character that the split cut in half", async () => {
    // "e with acute" is two bytes in UTF-8; put its first byte last in packet
    // one and its second byte first in packet two.
    const bytes = Buffer.concat([Buffer.alloc(FULL - 1, "a"), Buffer.from("é", "utf8"), Buffer.from("tail", "utf8")]);
    expect(bytes.length).toBe(FULL + 1 + 4);
    await connect({ replyPackets: () => [bytes.subarray(0, FULL), bytes.subarray(FULL)] });

    const response = await client.execute("mods", { timeoutMs: 3000 });

    expect(response).toBe(`${"a".repeat(FULL - 1)}étail`);
    expect(response).not.toContain("�");
  });

  it("a reply that is exactly one full packet still resolves, after the quiet window", async () => {
    const body = "q".repeat(FULL);
    await connect({ replyPackets: () => [body] });

    const response = await client.execute("exact", { timeoutMs: 3000 });

    expect(response).toBe(body);
    expect(warnCalls).toEqual([]);
  });

  it("a short single-packet reply is unchanged", async () => {
    await connect({ replyPackets: (cmd) => [`echo:${cmd}`] });

    expect(await client.execute("ping")).toBe("echo:ping");
  });

  it("the server closing right after a full packet still answers with what arrived", async () => {
    const body = "k".repeat(FULL);
    await connect({ replyPackets: () => [body], afterReply: (socket) => socket.end() });

    await expect(client.execute("quit", { timeoutMs: 3000 })).resolves.toBe(body);
  });
});

describe("SourceRconClient: the quiet window after a full packet (fake timers)", () => {
  let client;

  // execute() only needs a writable socket; replies are fed to _onData() by hand.
  function makeClient() {
    const c = new SourceRconClient({ host: "127.0.0.1", port: 1 });
    c.socket = { destroyed: false, write: (_buf, cb) => cb && cb() };
    return c;
  }

  function lastRequestId(c) {
    return [...c._pending.keys()].pop();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    warnCalls.length = 0;
    client = makeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately on a packet shorter than the limit", async () => {
    const promise = client.execute("short");
    client._onData(encodePacket(lastRequestId(client), TYPE_RESPONSE_VALUE, "k".repeat(FULL - 1)));

    await expect(promise).resolves.toBe("k".repeat(FULL - 1));
    expect(client._pending.size).toBe(0);
  });

  it("holds a full packet open for 150 ms, then resolves with it", async () => {
    const promise = client.execute("exact");
    let settled = false;
    promise.then(() => { settled = true; });
    client._onData(encodePacket(lastRequestId(client), TYPE_RESPONSE_VALUE, "k".repeat(FULL)));

    await vi.advanceTimersByTimeAsync(149);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(promise).resolves.toBe("k".repeat(FULL));
    expect(client._pending.size).toBe(0);
  });

  it("each further packet restarts the window, and a short one ends the reply at once", async () => {
    const promise = client.execute("showoptions");
    const id = lastRequestId(client);
    client._onData(encodePacket(id, TYPE_RESPONSE_VALUE, "a".repeat(FULL)));
    await vi.advanceTimersByTimeAsync(140);
    client._onData(encodePacket(id, TYPE_RESPONSE_VALUE, "b".repeat(FULL)));
    await vi.advanceTimersByTimeAsync(140);
    client._onData(encodePacket(id, TYPE_RESPONSE_VALUE, "c".repeat(7)));

    await expect(promise).resolves.toBe(`${"a".repeat(FULL)}${"b".repeat(FULL)}ccccccc`);
    expect(warnCalls).toEqual([]);
  });

  it("the command's own timeout stops counting once the reply has started", async () => {
    const promise = client.execute("slow", { timeoutMs: 50 });
    const id = lastRequestId(client);
    client._onData(encodePacket(id, TYPE_RESPONSE_VALUE, "a".repeat(FULL)));
    await vi.advanceTimersByTimeAsync(120); // past timeoutMs, inside the quiet window
    client._onData(encodePacket(id, TYPE_RESPONSE_VALUE, "tail"));

    await expect(promise).resolves.toBe(`${"a".repeat(FULL)}tail`);
  });

  it("a command that never got a reply still times out", async () => {
    const promise = client.execute("silent", { timeoutMs: 50 });
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it("losing the connection mid-reply answers with the part received", async () => {
    const promise = client.execute("showoptions");
    client._onData(encodePacket(lastRequestId(client), TYPE_RESPONSE_VALUE, "a".repeat(FULL)));
    client._onClose();

    await expect(promise).resolves.toBe("a".repeat(FULL));
  });

  it("losing the connection before any reply still rejects", async () => {
    const promise = client.execute("showoptions");
    const assertion = expect(promise).rejects.toThrow(/closed/);
    client._onClose();
    await assertion;
  });

  it("a packet for an id nobody waits on is still reported as an orphan", () => {
    client._onData(encodePacket(424242, TYPE_RESPONSE_VALUE, "late"));

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatch(/Orphaned RCON response for id=424242/);
  });
});
