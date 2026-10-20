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
