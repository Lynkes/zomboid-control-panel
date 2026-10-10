import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, setActiveServer, getActiveServer, deleteServer } from "../database/init.js";

// The edit dialog on the Servers page sends the whole server record back, so
// `useUpnp` is in every save even though that dialog has no UPnP control. The
// route used to treat the key being present as an edit: renaming the active
// server rewrote UPnP= in its .ini from the record's value (undoing a change
// made in Server Config since) and answered with a "UPnP setting saved ..."
// warning that the page showed as a "Warning" toast. Only a value that differs
// from the stored one is an edit.

function createResponse() {
  const response = { status: () => response, json: () => response };
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

describe("PUT /servers/:id -- an unchanged useUpnp in the body is not a UPnP edit", () => {
  let tmpRoot;
  let serverConfigPath;
  let iniPath;
  let previousActiveServerId;
  let createdServerId;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-upnp-unchanged-"));
    serverConfigPath = path.join(tmpRoot, "data", "Server");
    fs.mkdirSync(serverConfigPath, { recursive: true });
    iniPath = path.join(serverConfigPath, "UpnpUnchangedTest.ini");
    // The record below says useUpnp: true, but the ini was switched off in
    // Server Config afterwards (that page writes the ini, not the record).
    fs.writeFileSync(iniPath, "RCONPort=27015\nRCONPassword=x\nUPnP=false\n");
    previousActiveServerId = (await getActiveServer())?.id ?? null;
    createdServerId = null;
  });

  afterEach(async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (createdServerId != null) {
      await deleteServer(createdServerId);
      createdServerId = null;
    }
    if (previousActiveServerId != null) {
      await setActiveServer(previousActiveServerId);
    }
  });

  async function createActiveServer(overrides = {}) {
    const server = await createServer({
      name: "UpnpUnchangedTest",
      serverName: "UpnpUnchangedTest",
      installPath: tmpRoot,
      zomboidDataPath: path.dirname(serverConfigPath),
      serverConfigPath,
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "x",
      useUpnp: true,
      ...overrides,
    });
    createdServerId = server.id;
    await setActiveServer(server.id);
    return server;
  }

  async function put(server, body) {
    const { default: router } = await import("../routes/servers.js");
    const res = createResponse();
    await getRouteHandler(router, "/:id", "put")(
      { params: { id: String(server.id) }, body, app: { get: () => undefined } },
      res,
    );
    return res;
  }

  it("renaming with the record's own useUpnp leaves the ini alone and raises no warning", async () => {
    const server = await createActiveServer();

    const res = await put(server, { name: "Renamed", useUpnp: true });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("UPnP=false");
    expect(res.getBody().warnings).toBeUndefined();
    expect(res.getBody().server.name).toBe("Renamed");
  });

  it("an unchanged false is not an edit either", async () => {
    const server = await createActiveServer({ useUpnp: false });
    fs.writeFileSync(iniPath, "RCONPort=27015\nRCONPassword=x\nUPnP=true\n");

    const res = await put(server, { name: "Renamed", useUpnp: false });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("UPnP=true");
    expect(res.getBody().warnings).toBeUndefined();
  });

  it("an actual change still rewrites the ini and says it applies on the next start", async () => {
    const server = await createActiveServer();

    const res = await put(server, { name: "Renamed", useUpnp: false });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("UPnP=false");
    expect(res.getBody().warnings?.some((w) => /next time this server starts/i.test(w))).toBe(true);
  });

  it("a change back to on is applied when the record said off", async () => {
    const server = await createActiveServer({ useUpnp: false });

    const res = await put(server, { useUpnp: true });

    expect(res.getStatusCode()).toBe(200);
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("UPnP=true");
  });
});
