import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, deleteServer, getServer, getSetting, setSetting } from "../database/init.js";

// The start script writes -Xms{min}g -Xmx{max}g, and the JVM refuses to start
// with an initial heap larger than its maximum. Each value was range-checked on
// its own, but nothing compared the two, so a server could be saved (add, edit
// or the legacy app setting) that could never launch.

function createResponse() {
  const response = {};
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

let tmpRoot;
let installPath;
const createdIds = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-memory-order-"));
  installPath = path.join(tmpRoot, "server");
  fs.mkdirSync(installPath, { recursive: true });
});

afterEach(async () => {
  for (const id of createdIds.splice(0)) {
    await deleteServer(id);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function postServer(body) {
  const { default: router } = await import("../routes/servers.js");
  const res = createResponse();
  await getRouteHandler(router, "/", "post")({ body, app: { get: () => undefined } }, res);
  const created = res.getBody()?.server;
  if (created?.id !== undefined) createdIds.push(created.id);
  return res;
}

async function putServer(id, body) {
  const { default: router } = await import("../routes/servers.js");
  const res = createResponse();
  await getRouteHandler(router, "/:id", "put")(
    { params: { id: String(id) }, body, app: { get: () => undefined } },
    res,
  );
  return res;
}

const base = (name, extra = {}) => ({
  name,
  serverName: name,
  installPath,
  rconHost: "127.0.0.1",
  rconPort: 27015,
  rconPassword: "rconpw",
  ...extra,
});

describe("POST /servers -- minimum memory above maximum", () => {
  it("refuses the pair with a translated code and the two values", async () => {
    const res = await postServer(base("MemOrderCreateBad", { minMemory: 8, maxMemory: 4 }));

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({
      code: "MEMORY_MIN_EXCEEDS_MAX",
      params: { min: 8, max: 4 },
    });
  });

  it("refuses a minimum that only exceeds the default maximum", async () => {
    const res = await postServer(base("MemOrderCreateDefaultMax", { minMemory: 16 }));

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("MEMORY_MIN_EXCEEDS_MAX");
  });

  it("accepts min below max and min equal to max", async () => {
    expect((await postServer(base("MemOrderCreateOk", { minMemory: 2, maxMemory: 4, rconPort: 27021 }))).getStatusCode()).toBe(201);
    expect((await postServer(base("MemOrderCreateEqual", { minMemory: 4, maxMemory: 4, rconPort: 27022 }))).getStatusCode()).toBe(201);
  });

  it("does not judge a remote server, whose memory this panel never uses", async () => {
    const res = await postServer(
      base("MemOrderCreateRemote", { minMemory: 8, maxMemory: 4, isRemote: true, installPath: "", rconPort: 27023 }),
    );

    expect(res.getStatusCode()).toBe(201);
  });
});

describe("PUT /servers/:id -- minimum memory above maximum", () => {
  async function storedServer(name, extra = {}) {
    const server = await createServer({
      name,
      serverName: name,
      installPath,
      rconHost: "127.0.0.1",
      rconPort: 27030,
      rconPassword: "x",
      minMemory: 2,
      maxMemory: 4,
      ...extra,
    });
    createdIds.push(server.id);
    return server;
  }

  it("refuses raising the minimum above the stored maximum", async () => {
    const server = await storedServer("MemOrderPutMin");

    const res = await putServer(server.id, { minMemory: 16 });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "MEMORY_MIN_EXCEEDS_MAX", params: { min: 16, max: 4 } });
    expect((await getServer(server.id)).minMemory).toBe(2);
  });

  it("refuses lowering the maximum below the stored minimum", async () => {
    const server = await storedServer("MemOrderPutMax");

    const res = await putServer(server.id, { maxMemory: 1 });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("MEMORY_MIN_EXCEEDS_MAX");
  });

  it("refuses an inverted pair sent together (the edit dialog sends both)", async () => {
    const server = await storedServer("MemOrderPutBoth");

    const res = await putServer(server.id, { name: "Renamed", minMemory: 8, maxMemory: 4 });

    expect(res.getStatusCode()).toBe(400);
    expect((await getServer(server.id)).name).toBe("MemOrderPutBoth");
  });

  it("accepts a valid change to both, and to one against the stored other", async () => {
    const server = await storedServer("MemOrderPutOk");

    expect((await putServer(server.id, { minMemory: 3, maxMemory: 6 })).getStatusCode()).toBe(200);
    expect((await putServer(server.id, { maxMemory: 3 })).getStatusCode()).toBe(200);
    expect((await getServer(server.id)).maxMemory).toBe(3);
  });

  it("leaves an edit that sends no memory alone, even if the stored pair is already inverted", async () => {
    const server = await storedServer("MemOrderPutLegacy", { minMemory: 8, maxMemory: 4 });

    const res = await putServer(server.id, { name: "Renamed Legacy" });

    expect(res.getStatusCode()).toBe(200);
  });

  it("does not judge a remote server's hidden memory fields", async () => {
    const server = await storedServer("MemOrderPutRemote", { isRemote: true, installPath: "" });

    const res = await putServer(server.id, { minMemory: 8, maxMemory: 4 });

    expect(res.getStatusCode()).toBe(200);
  });
});

describe("PUT /app-settings -- minimum memory above maximum", () => {
  const previous = {};

  beforeEach(async () => {
    previous.minMemory = await getSetting("minMemory");
    previous.maxMemory = await getSetting("maxMemory");
  });

  afterEach(async () => {
    await setSetting("minMemory", previous.minMemory);
    await setSetting("maxMemory", previous.maxMemory);
  });

  async function putAppSettings(settings) {
    const { default: router } = await import("../routes/config.js");
    const res = createResponse();
    await getRouteHandler(router, "/app-settings", "put")(
      { body: { settings }, user: { role: "admin" }, app: { get: () => undefined } },
      res,
    );
    return res;
  }

  it("refuses an inverted pair in one save", async () => {
    const res = await putAppSettings({ minMemory: 8, maxMemory: 4 });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "MEMORY_MIN_EXCEEDS_MAX", params: { min: 8, max: 4 } });
  });

  it("judges a single value against the stored other one", async () => {
    await setSetting("minMemory", 2);
    await setSetting("maxMemory", 4);

    expect((await putAppSettings({ minMemory: 8 })).getStatusCode()).toBe(400);
    expect((await putAppSettings({ maxMemory: 1 })).getStatusCode()).toBe(400);
    expect((await putAppSettings({ maxMemory: 16 })).getStatusCode()).toBe(200);
    expect(await getSetting("maxMemory")).toBe(16);
  });

  it("does not touch a save that sends no memory", async () => {
    await setSetting("minMemory", 8);
    await setSetting("maxMemory", 4);

    expect((await putAppSettings({ darkMode: true })).getStatusCode()).toBe(200);
  });
});

vi.setConfig({ testTimeout: 30000 });
