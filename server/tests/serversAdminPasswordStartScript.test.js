import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";

// The admin password reaches the game through the start scripts, which cannot
// carry a double quote or a control character. They used to delete such a
// character (and every other shell metacharacter) from the password silently;
// the profile routes now refuse the password where it is saved, and keep any
// other password exactly as typed.

const db = await import("../database/init.js");
const { default: serversRouter } = await import("../routes/servers.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

let baseUrl;
let httpServer;
let root;
let installDir;
let counter = 0;

async function call(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

function profile(overrides = {}) {
  counter += 1;
  return {
    name: `Profile ${counter}`,
    serverName: `Profile${counter}`,
    installPath: installDir,
    rconHost: "127.0.0.1",
    rconPort: 27100 + counter,
    rconPassword: "rconpw",
    ...overrides,
  };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-admin-pw-"));
  installDir = path.join(root, "pz-install");
  fs.mkdirSync(path.join(installDir, "jre64"), { recursive: true });
  await db.initDatabase();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    req.user = { id: "u-admin", username: "admin", role: "admin" };
    next();
  });
  app.set("serverManager", { reloadConfig: async () => {} });
  app.use("/api/servers", serversRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/servers with an admin password", () => {
  it("refuses a double quote", async () => {
    const created = await call("POST", "/api/servers", profile({ adminPassword: 'pa"ss' }));
    expect(created.status).toBe(400);
    expect(created.json.code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);
  });

  it("refuses a line break", async () => {
    const created = await call("POST", "/api/servers", profile({ adminPassword: "pa\nss" }));
    expect(created.status).toBe(400);
    expect(created.json.code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);
  });

  it("keeps a password full of shell characters exactly as typed", async () => {
    const created = await call("POST", "/api/servers", profile({ adminPassword: "P@ss%w0rd!&x$y'`\\" }));
    expect(created.status).toBe(201);
    expect((await db.getServer(created.json.server.id)).adminPassword).toBe("P@ss%w0rd!&x$y'`\\");
  });
});

describe("PUT /api/servers/:id with an admin password", () => {
  it("refuses a double quote or a control character, and leaves the stored password alone", async () => {
    const created = await call("POST", "/api/servers", profile({ adminPassword: "original" }));
    expect(created.status).toBe(201);
    const id = created.json.server.id;

    const quote = await call("PUT", `/api/servers/${id}`, { adminPassword: 'pa"ss' });
    expect(quote.status).toBe(400);
    expect(quote.json.code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);

    const control = await call("PUT", `/api/servers/${id}`, { adminPassword: "pa\r\nss" });
    expect(control.status).toBe(400);
    expect(control.json.code).toBe(ErrorCode.ADMIN_PASSWORD_UNSUPPORTED_CHARACTERS);

    expect((await db.getServer(id)).adminPassword).toBe("original");
  });

  it("stores any other password as typed", async () => {
    const created = await call("POST", "/api/servers", profile());
    const id = created.json.server.id;
    const updated = await call("PUT", `/api/servers/${id}`, { adminPassword: "P@ss%w0rd!&x$y" });
    expect(updated.status).toBe(200);
    expect((await db.getServer(id)).adminPassword).toBe("P@ss%w0rd!&x$y");
  });
});
