import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// PR #193 review leftover (security sweep 2026-10-04): the
// activeServerChanged broadcast goes to every signed-in socket, whatever its
// role, and carried the whole server record -- install, data and config
// folders, start command, RCON host and port and the masked passwords. It
// now carries only what the page reading the payload uses.
//
// Full stack through the real servers router and the real, unmocked
// database/init.js, with a recording stand-in for Socket.IO.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");

const SUMMARY_KEYS = [
  "dockerContainerId",
  "dockerContainerName",
  "id",
  "isActive",
  "isRemote",
  "maxMemory",
  "name",
  "serverName",
];
const PRIVATE_FIELDS = [
  "installPath",
  "serverPath",
  "zomboidDataPath",
  "serverConfigPath",
  "startCommand",
  "rconHost",
  "rconPort",
  "rconPassword",
  "adminPassword",
];

let baseUrl;
let httpServer;
let root;
const emitted = [];
const ids = [];

async function call(method, url) {
  const res = await fetch(baseUrl + url, { method });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function makeServer(n) {
  const dataDir = path.join(root, `Data${n}`);
  fs.mkdirSync(path.join(dataDir, "Server"), { recursive: true });
  const server = await db.createServer({
    name: `Broadcast ${n}`,
    serverName: `Broadcast${n}`,
    installPath: path.join(root, `install${n}`),
    zomboidDataPath: dataDir,
    serverConfigPath: path.join(dataDir, "Server"),
    dockerContainerName: `pz-${n}`,
    rconHost: "10.0.0.5",
    rconPort: 27100 + n,
    rconPassword: `rcon-secret-${n}`,
    adminPassword: `admin-secret-${n}`,
    maxMemory: 8192,
  });
  ids.push(server.id);
  return server;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-active-broadcast-"));
  await db.initDatabase();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "u-admin", username: "admin", role: "admin" };
    next();
  });
  app.set("io", { emit: (event, payload) => emitted.push({ event, payload }) });
  app.use("/api/servers", serversRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  for (const id of ids) await db.deleteServer(id).catch(() => {});
  await new Promise((r) => httpServer?.close(r));
});

function lastBroadcast() {
  const events = emitted.filter((e) => e.event === "activeServerChanged");
  return events[events.length - 1]?.payload;
}

function expectSummaryOnly(server, expected) {
  expect(Object.keys(server).sort()).toEqual(SUMMARY_KEYS);
  for (const field of PRIVATE_FIELDS) expect(server).not.toHaveProperty(field);
  expect(server).toMatchObject({
    id: expected.id,
    name: expected.name,
    serverName: expected.serverName,
    isActive: true,
    isRemote: false,
    // Dashboard's resolveClientProvider() tells a Docker server by it.
    dockerContainerName: expected.dockerContainerName,
    maxMemory: expected.maxMemory,
  });
}

describe("activeServerChanged carries a summary, not the server record", () => {
  it("on POST /:id/activate", async () => {
    const first = await makeServer(1);
    const second = await makeServer(2);
    const r = await call("POST", `/api/servers/${second.id}/activate`);
    expect(r.status).toBe(200);
    // The requester's own HTTP response still has the full (masked) record.
    expect(r.json.server.installPath).toBe(second.installPath);
    expectSummaryOnly(lastBroadcast().server, second);
    await call("POST", `/api/servers/${first.id}/activate`);
  });

  it("on DELETE /:id of the active server, naming the one promoted", async () => {
    const doomed = await makeServer(3);
    await call("POST", `/api/servers/${doomed.id}/activate`);
    const r = await call("DELETE", `/api/servers/${doomed.id}`);
    expect(r.status).toBe(200);
    const promoted = await db.getActiveServer();
    expectSummaryOnly(lastBroadcast().server, promoted);
  });
});
