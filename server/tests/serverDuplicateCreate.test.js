import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, deleteServer, getServers } from "../database/init.js";
import { findDuplicateLocalServer } from "../utils/serverDuplicate.js";

// Adding a server twice (a retry after a request that looked like it failed, a
// double click) used to leave two identical cards: createServer() had no
// duplicate check at all. A local server is its server name inside its data
// folder, so the same name in the same folder is refused with a translated
// code and the existing server's name.

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

describe("findDuplicateLocalServer", () => {
  const existing = {
    name: "Survival",
    serverName: "survival",
    zomboidDataPath: "D:\\pz\\data",
    isRemote: false,
  };

  it("matches the same name in the same folder, whatever the separators or a trailing one", () => {
    expect(findDuplicateLocalServer([existing], { serverName: "survival", zomboidDataPath: "D:\\pz\\data" })).toBe(existing);
    expect(findDuplicateLocalServer([existing], { serverName: "survival", zomboidDataPath: "D:/pz/data/" })).toBe(existing);
    expect(findDuplicateLocalServer([existing], { serverName: " survival ", zomboidDataPath: "D:\\pz\\data\\" })).toBe(existing);
  });

  it("does not match a different name or a different folder", () => {
    expect(findDuplicateLocalServer([existing], { serverName: "survival2", zomboidDataPath: "D:\\pz\\data" })).toBeNull();
    expect(findDuplicateLocalServer([existing], { serverName: "survival", zomboidDataPath: "D:\\pz\\data2" })).toBeNull();
  });

  it("never judges a remote server, or a profile with no data folder", () => {
    expect(findDuplicateLocalServer([existing], { serverName: "survival", zomboidDataPath: "D:\\pz\\data", isRemote: true })).toBeNull();
    expect(findDuplicateLocalServer([{ ...existing, isRemote: true }], { serverName: "survival", zomboidDataPath: "D:\\pz\\data" })).toBeNull();
    expect(findDuplicateLocalServer([existing], { serverName: "survival", zomboidDataPath: null })).toBeNull();
    expect(findDuplicateLocalServer([{ ...existing, zomboidDataPath: null }], { serverName: "survival", zomboidDataPath: null })).toBeNull();
  });
});

describe("createServer / POST /servers refuse an exact duplicate", () => {
  let tmpRoot;
  let dataA;
  let dataB;
  const createdIds = [];

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-dup-create-"));
    dataA = path.join(tmpRoot, "dataA");
    dataB = path.join(tmpRoot, "dataB");
    fs.mkdirSync(dataA, { recursive: true });
    fs.mkdirSync(dataB, { recursive: true });
  });

  afterEach(async () => {
    for (const id of createdIds.splice(0)) await deleteServer(id);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const record = (extra = {}) => ({
    name: "DupTest",
    serverName: "DupTest",
    installPath: tmpRoot,
    zomboidDataPath: dataA,
    rconHost: "127.0.0.1",
    rconPort: 27015,
    rconPassword: "x",
    ...extra,
  });

  async function make(extra) {
    const server = await createServer(record(extra));
    createdIds.push(server.id);
    return server;
  }

  it("the second identical local server is refused with the 409 code, and nothing is added", async () => {
    await make();
    const before = (await getServers()).length;

    await expect(createServer(record())).rejects.toMatchObject({
      code: "SERVER_ALREADY_EXISTS",
      status: 409,
      params: { name: "DupTest" },
    });
    expect((await getServers()).length).toBe(before);
  });

  it("the same name in another data folder, another name in the same folder, a remote copy, and two with no folder are all fine", async () => {
    await make();
    await make({ zomboidDataPath: dataB });
    await make({ name: "DupTest2", serverName: "DupTest2" });
    await make({ isRemote: true, rconHost: "10.0.0.5" });
    await make({ name: "NoFolder", serverName: "NoFolder", zomboidDataPath: null });
    await make({ name: "NoFolder", serverName: "NoFolder", zomboidDataPath: null });
  });

  it("POST /servers answers 409 with the code and the existing server's name, and keeps the one server", async () => {
    const { default: router } = await import("../routes/servers.js");
    const post = async (body) => {
      const res = createResponse();
      await getRouteHandler(router, "/", "post")({ body, app: { get: () => undefined } }, res);
      return res;
    };

    const first = await post(record());
    expect(first.getStatusCode()).toBe(201);
    createdIds.push(first.getBody().server.id);
    const before = (await getServers()).length;

    const second = await post(record({ name: "Another display name" }));

    expect(second.getStatusCode()).toBe(409);
    expect(second.getBody()).toMatchObject({ code: "SERVER_ALREADY_EXISTS", params: { name: "DupTest" } });
    expect((await getServers()).length).toBe(before);
  });
});
