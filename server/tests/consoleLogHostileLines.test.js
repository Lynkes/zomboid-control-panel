import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// GET /api/server/console-log and /console-log/stream serve the game's
// server-console.txt to server.world_events (moderators included). Lines in
// it come from the game, from every mod's Lua (print), and from players.

const init = await import("../database/init.js");
const { default: serverRouter } = await import("../routes/server.js");

const MARKER = `zcp-console-hostile-${process.pid}`;
const DATA_DIR = path.join(os.tmpdir(), MARKER, "Zomboid");
const LOG = path.join(DATA_DIR, "server-console.txt");

let baseUrl;
let httpServer;
let currentRole = "moderator";

async function getJson(url) {
  const res = await fetch(baseUrl + url);
  expect(res.status, url).toBe(200);
  return res.json();
}

beforeAll(async () => {
  await init.initDatabase();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOG, "");
  const server = await init.createServer({ name: "Hostile", serverName: "servertest", zomboidDataPath: DATA_DIR });
  await init.setActiveServer(server.id);

  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("io", null);
  app.use("/api/server", serverRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(path.join(os.tmpdir(), MARKER), { recursive: true, force: true });
});

beforeEach(() => {
  currentRole = "moderator";
});

// Security audit 2026-10-20: on a world's first start the game logs the
// -adminpassword value the panel passes it. The Console page never needs it,
// so no role gets it -- not a moderator, not an admin.
describe("the game's 'Command line admin password:' line", () => {
  const FIRST_BOOT = [
    "LOG  : General      f:0 st:195,165,107> User 'admin' not found, creating it ",
    "LOG  : General      f:0 st:195,165,107> Command line admin password: Sup3rS3cret!",
    "LOG  : General      f:0 st:195,166,001> RCON: listening on port 27015",
    "",
  ].join("\n");
  const REDACTED = "LOG  : General      f:0 st:195,165,107> Command line admin password: [REDACTED]";

  for (const role of ["moderator", "technician", "admin"]) {
    it(`is redacted for ${role} in GET /console-log and /console-log/stream`, async () => {
      currentRole = role;
      fs.writeFileSync(LOG, FIRST_BOOT);
      for (const filter of ["all", "filtered"]) {
        const log = await getJson(`/api/server/console-log?filter=${filter}`);
        expect(JSON.stringify(log)).not.toContain("Sup3rS3cret!");
        expect(log.lines).toContain(REDACTED);
      }

      const stream = await getJson("/api/server/console-log/stream?filter=all&lastSize=0");
      expect(JSON.stringify(stream)).not.toContain("Sup3rS3cret!");
      expect(stream.newLines).toContain(REDACTED);

      // A poll that picks the line up as new output, not as a rotation.
      fs.writeFileSync(LOG, "LOG  : General      > SERVER STARTED\n");
      const { currentSize, identity } = await getJson("/api/server/console-log/stream?filter=all&lastSize=0");
      fs.appendFileSync(LOG, FIRST_BOOT);
      const next = await getJson(
        `/api/server/console-log/stream?filter=all&lastSize=${currentSize}&identity=${encodeURIComponent(identity)}`,
      );
      expect(next.rotated).toBeUndefined();
      expect(next.newLines).toContain(REDACTED);
      expect(JSON.stringify(next)).not.toContain("Sup3rS3cret!");
    });
  }

  // Adversary pass: lastSize is the caller's. Aimed just past the marker, the
  // stream used to answer with the rest of that line: the bare password.
  it("a lastSize aimed into the middle of the line returns no part of it", async () => {
    fs.writeFileSync(LOG, "LOG  : General      > SERVER STARTED\n");
    const { identity } = await getJson("/api/server/console-log/stream?filter=all&lastSize=0");
    fs.writeFileSync(LOG, FIRST_BOOT);
    const marker = "Command line admin password: ";
    const offsets = [
      Buffer.byteLength(FIRST_BOOT.slice(0, FIRST_BOOT.indexOf(marker) + marker.length)),
      Buffer.byteLength(FIRST_BOOT.slice(0, FIRST_BOOT.indexOf("S3cret"))),
      Buffer.byteLength(FIRST_BOOT.slice(0, FIRST_BOOT.indexOf(marker) + 3)),
    ];
    for (const lastSize of offsets) {
      const res = await getJson(
        `/api/server/console-log/stream?filter=all&lastSize=${lastSize}&identity=${encodeURIComponent(identity)}`,
      );
      expect(res.rotated).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain("S3cret");
      // The whole lines after it still arrive.
      expect(res.newLines).toEqual(["LOG  : General      f:0 st:195,166,001> RCON: listening on port 27015"]);
    }
  });

  it("an offset in a line that is still being written drops that line until its newline, then carries on", async () => {
    fs.writeFileSync(LOG, "first\n");
    const { identity } = await getJson("/api/server/console-log/stream?filter=all&lastSize=0");
    fs.appendFileSync(LOG, "Command line admin password: Sup3r");
    const cut = Buffer.byteLength("first\nCommand line admin password: Su");
    const partial = await getJson(
      `/api/server/console-log/stream?filter=all&lastSize=${cut}&identity=${encodeURIComponent(identity)}`,
    );
    expect(partial.newLines).toEqual([]);
    fs.appendFileSync(LOG, "S3cret!\nnext line\n");
    const rest = await getJson(
      `/api/server/console-log/stream?filter=all&lastSize=${partial.currentSize}&identity=${encodeURIComponent(identity)}`,
    );
    expect(rest.newLines).toEqual(["next line"]);
    expect(JSON.stringify([partial, rest])).not.toContain("3r");
  });

  it("a poll that ended mid-line still gets the whole line on the next poll", async () => {
    fs.writeFileSync(LOG, "first\nCommand line admin password: Sup3r");
    const first = await getJson("/api/server/console-log/stream?filter=all&lastSize=0");
    expect(first.newLines).toEqual(["first"]);
    fs.appendFileSync(LOG, "S3cret!\nafter\n");
    const next = await getJson(
      `/api/server/console-log/stream?filter=all&lastSize=${first.currentSize}&identity=${encodeURIComponent(first.identity)}`,
    );
    expect(next.newLines).toEqual(["Command line admin password: [REDACTED]", "after"]);
  });
});

describe("the default (filtered) Console view: a line a mod printed", () => {
  // Security audit 2026-10-20: /Steam client .* is initiating/ rescanned the
  // rest of the line from every "Steam client " in it -- quadratic, and the
  // Console page filters every line it loads.
  it("a 400 KB line of repeated 'Steam client ' is filtered in well under a second", async () => {
    fs.writeFileSync(LOG, "LOG  : General      > " + "Steam client ".repeat(32 * 1024) + "\nSERVER STARTED\n");
    const started = performance.now();
    const log = await getJson("/api/server/console-log");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(log.lines.some((line) => line.includes("SERVER STARTED"))).toBe(true);
  });

  it("still keeps the real Steam client line among the important ones", async () => {
    fs.writeFileSync(
      LOG,
      [
        "LOG  : Network      > Steam client 76561198000000000 is initiating a connection",
        "LOG  : General      > Steam client says hello",
        "",
      ].join("\n"),
    );
    const log = await getJson("/api/server/console-log?filter=important");
    expect(log.lines).toEqual(["LOG  : Network      > Steam client 76561198000000000 is initiating a connection"]);
  });
});
