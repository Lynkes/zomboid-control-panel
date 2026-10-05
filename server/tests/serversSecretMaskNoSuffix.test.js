import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// AUTHZ-4 (security sweep 2026-10-04): GET /api/servers, /active and /:id
// have no capability gate (every role's pages read the server list), and
// maskSecretValue() kept the last 4 characters of each secret "for
// reference" -- so every signed-in role, moderator included, read the tail
// of each server's RCON and admin password. The mask is now a fixed
// placeholder that says only that a value is set.
//
// Full stack through the real servers router and the real, unmocked
// database/init.js, signed in as the seeded moderator role.
const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { default: serverFilesRouter } = await import("../routes/serverFiles.js");
const { isMaskedSecret, maskSecretValue, maskSensitiveObject } = await import(
  "../utils/sanitize.js"
);

const RCON = "rcon-Secret-WXYZ";
const ADMIN = "admin-Secret-QRST";

let baseUrl;
let httpServer;
let currentRole = "moderator";
let serverId;
let configDir;

async function call(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-secret-mask-"));
  const dataDir = path.join(root, "Zomboid");
  configDir = path.join(dataDir, "Server");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "Masked.ini"),
    `PublicName=Masked\nRCONPassword=${RCON}\nPassword=join-Secret-MNOP\n`,
  );

  await db.initDatabase();
  const server = await db.createServer({
    name: "Masked",
    serverName: "Masked",
    installPath: path.join(root, "pz-install"),
    zomboidDataPath: dataDir,
    rconHost: "127.0.0.1",
    rconPort: 27998,
    rconPassword: RCON,
    adminPassword: ADMIN,
  });
  serverId = server.id;
  await db.setActiveServer(serverId);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.use("/api/servers", serversRouter);
  app.use("/api/server-files", serverFilesRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => httpServer?.close(r));
});

function expectNoSecretTail(record) {
  for (const [key, secret] of [["rconPassword", RCON], ["adminPassword", ADMIN]]) {
    expect(record[key]).toBe("••••••••");
    expect(record[key]).not.toContain(secret.slice(-4));
  }
}

describe("GET /api/servers* as moderator -- no part of a password (AUTHZ-4)", () => {
  it("the list", async () => {
    currentRole = "moderator";
    const r = await call("GET", "/api/servers");
    expect(r.status).toBe(200);
    expectNoSecretTail(r.json.servers.find((s) => s.id === serverId));
  });

  it("the active server", async () => {
    currentRole = "moderator";
    const r = await call("GET", "/api/servers/active");
    expect(r.status).toBe(200);
    expectNoSecretTail(r.json.server);
  });

  it("one server", async () => {
    currentRole = "moderator";
    const r = await call("GET", `/api/servers/${serverId}`);
    expect(r.status).toBe(200);
    expectNoSecretTail(r.json.server);
  });
});

describe("the placeholder still round-trips without overwriting the stored secret", () => {
  it("PUT with the placeholder echoed back keeps the real passwords", async () => {
    currentRole = "admin";
    const listed = await call("GET", `/api/servers/${serverId}`);
    const r = await call("PUT", `/api/servers/${serverId}`, {
      name: "Masked",
      rconPassword: listed.json.server.rconPassword,
      adminPassword: listed.json.server.adminPassword,
    });
    expect(r.status).toBe(200);
    const stored = await db.getServer(serverId);
    expect(stored.rconPassword).toBe(RCON);
    expect(stored.adminPassword).toBe(ADMIN);
  });

  it("the older last-4 shape a page loaded before an upgrade may send is still recognised", () => {
    expect(isMaskedSecret("••••••••WXYZ")).toBe(true);
    expect(isMaskedSecret(maskSecretValue(RCON))).toBe(true);
  });
});

describe("every other masked surface loses the tail too", () => {
  it("maskSensitiveObject (app settings, structured .ini)", () => {
    const masked = maskSensitiveObject({ steamApiKey: "steam-key-ABCD", jwtSecret: "jwt-EFGH" });
    expect(masked).toEqual({ steamApiKey: "••••••••", jwtSecret: "••••••••" });
  });

  it("GET /api/server-files/raw/ini", async () => {
    currentRole = "technician";
    const r = await call("GET", "/api/server-files/raw/ini");
    expect(r.status).toBe(200);
    expect(r.json.content).toContain("RCONPassword=••••••••\n");
    expect(r.json.content).toContain("Password=••••••••\n");
    expect(r.json.content).not.toContain("WXYZ");
    expect(r.json.content).not.toContain("MNOP");
  });
});
