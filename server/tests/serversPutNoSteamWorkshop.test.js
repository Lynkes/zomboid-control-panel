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
// another profile sharing the same game folder -- and refuses the mirror
// move too: a Workshop profile brought into a folder another profile
// launches without Steam from turns that one Workshop. POST /api/servers
// refuses to create such a profile there.
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
    // RCE-STARTCMD: setting a launch target now needs files.manage, which
    // only admin holds by default -- this suite's concern is the no-Steam /
    // Workshop conflict logic, not that gate, so it acts as an admin.
    { params: { id: String(id) }, body, app: { get: () => undefined }, user: { id: "admin-1", username: "admin", role: "admin" } },
    res,
  );
  return res;
}

async function post(body) {
  const { default: router } = await import("../routes/servers.js");
  const layer = router.stack.find((entry) => entry.route?.path === "/" && entry.route.methods.post);
  const res = createResponse();
  await layer.route.stack[layer.route.stack.length - 1].handle(
    { body, app: { get: () => undefined }, user: { id: "admin-1", username: "admin", role: "admin" } },
    res,
  );
  const id = res.getBody()?.server?.id;
  if (id) created.push(id);
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

// An operator's own launcher script; launchLooksNoSteam() reads its head.
function writeLauncher(file, javaArgs) {
  fs.writeFileSync(file, `@echo off\r\njava ${javaArgs} -cp . zombie.network.GameServer\r\n`);
  return file;
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

  // The edit dialog saves the whole record, useNoSteam included, so the
  // guard must judge what the edit CHANGES: a profile already in that state
  // stays saveable, while every way of creating it is refused.
  it("lets a profile that already launches without Steam on a Workshop folder be saved (a rename)", async () => {
    const stuck = await makeServer("StuckOne", root, { bridgeDelivery: "workshop", useNoSteam: true });
    const res = await put(stuck.id, { name: "Renamed", useNoSteam: true, installPath: root });
    expect(res.getStatusCode()).toBe(200);
    expect((await getServer(stuck.id)).name).toBe("Renamed");
  });

  it("refuses moving a -nosteam profile into a Workshop game folder, alone or with the flag in the same request", async () => {
    const workshopDir = fs.mkdtempSync(path.join(root, "w-"));
    await makeServer("WorkshopHome", workshopDir, { bridgeDelivery: "workshop" });
    const noSteam = await makeServer("NoSteamMover", fs.mkdtempSync(path.join(root, "n-")), { useNoSteam: true });
    expect((await put(noSteam.id, { installPath: workshopDir })).getStatusCode()).toBe(409);

    const local = await makeServer("LocalMover", fs.mkdtempSync(path.join(root, "l-")));
    const both = await put(local.id, { installPath: workshopDir, useNoSteam: true });
    expect(both.getStatusCode()).toBe(409);
    expect(both.getBody()).toMatchObject({ code: "SERVER_NOSTEAM_CONFLICTS_WITH_WORKSHOP_BRIDGE" });
    expect((await getServer(local.id)).useNoSteam).toBeFalsy();
  });

  // The other direction: the edited profile keeps Steam, but the folder it
  // moves into decides for everyone there. The -nosteam profile would be
  // Workshop from its next launch, which archives the shared loose file and
  // skips its ini -- no bridge at all.
  it("refuses moving a Workshop profile into a game folder a -nosteam profile launches from, and names it", async () => {
    const noSteamDir = fs.mkdtempSync(path.join(root, "n-"));
    await makeServer("NoSteamHome", noSteamDir, { useNoSteam: true });
    const workshopDir = fs.mkdtempSync(path.join(root, "w-"));
    const mover = await makeServer("WorkshopMover", workshopDir, { bridgeDelivery: "workshop" });

    const res = await put(mover.id, { installPath: noSteamDir });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({
      code: "SERVER_NOSTEAM_SIBLING_CONFLICTS_WITH_WORKSHOP_BRIDGE",
      params: { names: "NoSteamHome" },
    });
    expect((await getServer(mover.id)).installPath).toBe(workshopDir);

    // Pointing serverPath at a launcher in that folder moves it there too.
    const viaLauncher = await put(mover.id, { serverPath: path.join(noSteamDir, "StartServer64.bat") });
    expect(viaLauncher.getStatusCode()).toBe(409);
    expect((await getServer(mover.id)).serverPath).toBeFalsy();
  });

  it("refuses it when the sibling's own launcher script starts without Steam", async () => {
    const noSteamDir = fs.mkdtempSync(path.join(root, "n-"));
    const launcher = writeLauncher(path.join(noSteamDir, "StartServer64_nosteam.bat"), "-Dzomboid.steam=0");
    await makeServer("LauncherNoSteam", launcher);
    const mover = await makeServer("WorkshopMover2", fs.mkdtempSync(path.join(root, "w-")), { bridgeDelivery: "workshop" });
    const res = await put(mover.id, { installPath: noSteamDir });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody().params).toEqual({ names: "LauncherNoSteam" });
  });

  it("refuses turning a remote Workshop profile local on a folder a -nosteam profile launches from", async () => {
    await makeServer("NoSteamLocal", root, { useNoSteam: true });
    const remote = await makeServer("RemoteWorkshop", root, { isRemote: true, bridgeDelivery: "workshop" });
    const res = await put(remote.id, { isRemote: false });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "SERVER_NOSTEAM_SIBLING_CONFLICTS_WITH_WORKSHOP_BRIDGE" });
    expect((await getServer(remote.id)).isRemote).toBe(true);
  });

  it("allows a Workshop profile to move into a folder whose profiles all launch with Steam", async () => {
    const steamDir = fs.mkdtempSync(path.join(root, "s-"));
    await makeServer("SteamHome", steamDir);
    const mover = await makeServer("WorkshopMover3", fs.mkdtempSync(path.join(root, "w-")), { bridgeDelivery: "workshop" });
    expect((await put(mover.id, { installPath: steamDir })).getStatusCode()).toBe(200);
  });

  // Both sides of a group that is already in that state (a launcher script
  // edited outside the panel, a record from before this guard) must stay
  // editable: the dialog resends installPath, isRemote and useNoSteam.
  it("lets both profiles of an existing Workshop/-nosteam folder be saved", async () => {
    const workshop = await makeServer("WorkshopStuck", root, { bridgeDelivery: "workshop" });
    const noSteam = await makeServer("NoSteamStuck", root, { useNoSteam: true });
    const workshopSave = await put(workshop.id, { name: "WorkshopRenamed", installPath: root, isRemote: false, useNoSteam: false });
    expect(workshopSave.getStatusCode()).toBe(200);
    const noSteamSave = await put(noSteam.id, { name: "NoSteamRenamed", installPath: root, isRemote: false, useNoSteam: true });
    expect(noSteamSave.getStatusCode()).toBe(200);
  });

  it("refuses a -nosteam start command on a Workshop server", async () => {
    const workshop = await makeServer("WorkshopCmd", root, { bridgeDelivery: "workshop" });
    const res = await put(workshop.id, { startCommand: "StartServer64.bat -nosteam" });
    expect(res.getStatusCode()).toBe(409);
  });

  // The folder decides the method, so a profile CREATED on a Workshop folder
  // is Workshop from its first launch; it can't be created -nosteam either.
  it("POST /servers refuses a new -nosteam profile on a Workshop game folder", async () => {
    await makeServer("WorkshopHost", root, { bridgeDelivery: "workshop" });
    const body = { name: "NewNoSteam", installPath: root, rconHost: "127.0.0.1", rconPort: 27015, rconPassword: "x" };
    const refused = await post({ ...body, useNoSteam: true });
    expect(refused.getStatusCode()).toBe(409);
    expect(refused.getBody()).toMatchObject({ code: "SERVER_NOSTEAM_CONFLICTS_WITH_WORKSHOP_BRIDGE" });

    expect((await post(body)).getStatusCode()).toBe(201);
    const elsewhere = { ...body, name: "OtherNoSteam", installPath: fs.mkdtempSync(path.join(root, "o-")) };
    expect((await post({ ...elsewhere, useNoSteam: true })).getStatusCode()).toBe(201);
  });

  it("POST /servers refuses a new profile whose launcher script in a Workshop game folder starts without Steam", async () => {
    await makeServer("WorkshopHost2", root, { bridgeDelivery: "workshop" });
    const launcher = writeLauncher(path.join(root, "StartServer64_nosteam.bat"), "-Dzomboid.steam=0");
    const body = { name: "LauncherProfile", installPath: launcher, rconHost: "127.0.0.1", rconPort: 27015, rconPassword: "x" };
    const refused = await post(body);
    expect(refused.getStatusCode()).toBe(409);
    expect(refused.getBody()).toMatchObject({ code: "SERVER_NOSTEAM_CONFLICTS_WITH_WORKSHOP_BRIDGE" });

    // The same launcher with Steam is fine there.
    writeLauncher(launcher, "-Xmx4g");
    expect((await post(body)).getStatusCode()).toBe(201);
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
