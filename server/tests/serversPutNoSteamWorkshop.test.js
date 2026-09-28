import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, deleteServer, getServer, updateServer } from "../database/init.js";

// I8: a server that gets PanelBridge from the Steam Workshop needs Steam to
// download it. Launched without Steam it starts with no bridge while Mods=
// still names the Workshop mod, so every join fails. PUT /api/servers/:id
// refuses to turn "Launch without Steam" on until PanelBridge is switched
// back to panel-installed -- including when the Workshop choice was made by
// another profile sharing the same game folder.
function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status(code) {
      statusCode = code;
      return response;
    },
    json(payload) {
      body = payload;
      return response;
    },
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

async function put(id, body) {
  const { default: router } = await import("../routes/servers.js");
  const layer = router.stack.find((entry) => entry.route?.path === "/:id" && entry.route.methods.put);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle(
    { params: { id: String(id) }, body, app: { get: () => undefined } },
    res,
  );
  return res;
}

let root;
const created = [];

async function makeServer(name, installPath, extra = {}) {
  const server = await createServer({
    name,
    serverName: name,
    installPath,
    isRemote: false,
    rconHost: "127.0.0.1",
    rconPort: 27015,
    rconPassword: "x",
  });
  created.push(server.id);
  if (Object.keys(extra).length) await updateServer(server.id, extra);
  return server;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "servers-put-nosteam-"));
});

afterEach(async () => {
  while (created.length) await deleteServer(created.pop());
  fs.rmSync(root, { recursive: true, force: true });
});

describe("PUT /servers/:id useNoSteam vs Workshop PanelBridge delivery", () => {
  it("refuses useNoSteam=true on a Workshop server with the coded 409", async () => {
    const server = await makeServer("WorkshopOne", root, { bridgeDelivery: "workshop" });
    const res = await put(server.id, { useNoSteam: true });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "SERVER_NOSTEAM_CONFLICTS_WITH_WORKSHOP_BRIDGE" });
    expect((await getServer(server.id)).useNoSteam).toBeFalsy();
  });

  it("refuses it when a sibling on the same game folder chose the Workshop", async () => {
    const local = await makeServer("LocalOne", root);
    await makeServer("WorkshopSibling", `${root}${path.sep}`, { bridgeDelivery: "workshop" });
    const res = await put(local.id, { useNoSteam: true });
    expect(res.getStatusCode()).toBe(409);
  });

  it("allows it for a panel-installed server, and allows turning it off anywhere", async () => {
    const local = await makeServer("LocalTwo", root);
    expect((await put(local.id, { useNoSteam: true })).getStatusCode()).toBe(200);
    const workshop = await makeServer("WorkshopTwo", fs.mkdtempSync(path.join(root, "w-")), { bridgeDelivery: "workshop" });
    expect((await put(workshop.id, { useNoSteam: false })).getStatusCode()).toBe(200);
  });

  it("the delivery fields can't be set through this route at all", async () => {
    const local = await makeServer("LocalThree", root);
    const res = await put(local.id, {
      bridgeDelivery: "workshop",
      bridgeDeliverySwitch: { to: "workshop" },
    });
    expect(res.getStatusCode()).toBe(400);
    const stored = await getServer(local.id);
    expect(stored.bridgeDelivery).toBeUndefined();
    expect(stored.bridgeDeliverySwitch).toBeUndefined();
  });
});
