import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Mod Manager groups: a named, ordered list of mod IDs shared by every admin
// of the panel (stored in the panel database). The list order is the load order
// those mods must keep in Mods=; POST /save-order enforces it (when the panel
// setting is on, which it is unless an admin turned it off) and POST
// /groups/apply puts it into the current Mods= line.
//
// Real, unmocked database/init.js and mods router, with a real ini on disk.
const db = await import("../database/init.js");
const { default: modsRouter } = await import("../routes/mods.js");
const runRoute = createRouteRunner(modsRouter);

let fx;

beforeAll(async () => {
  await db.initDatabase();
});

beforeEach(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  delete state.data.settings.modGroupsEnforce;
  fx = makeServerFixture({
    prefix: "mods-groups-",
    ini: "Mods=Alpha;Beta\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n",
  });
  state.data.servers = [{ ...fx.activeServer, name: "Test", isActive: true }];
});

afterEach(() => {
  fx.cleanup();
});

afterAll(async () => {
  const state = await db.getDb();
  state.data.mod_groups = [];
  state.data.servers = [];
});

const call = (path, method, req = {}) => runRoute(path, method, req);
const create = (body) => call("/groups", "post", { body });
const modsLine = () => fx.iniValue("Mods");
const ids = (n) => Array.from({ length: n }, (_, i) => `mod${i}`);

async function seed(...groups) {
  const state = await db.getDb();
  state.data.mod_groups = groups.map(([name, ...modIds], i) => ({
    id: `seed-${i}`,
    name,
    description: "",
    modIds,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }));
}

describe("route registration", () => {
  it("registers the literal /groups/* paths before /groups/:id", () => {
    const at = (path, method) =>
      modsRouter.stack.findIndex((layer) => layer.route?.path === path && layer.route.methods[method]);
    expect(at("/groups/enforce", "put")).toBeGreaterThan(-1);
    expect(at("/groups/enforce", "put")).toBeLessThan(at("/groups/:id", "put"));
    expect(at("/groups/import", "post")).toBeGreaterThan(-1);
    expect(at("/groups/status", "get")).toBeGreaterThan(-1);
    expect(at("/groups/apply", "post")).toBeGreaterThan(-1);
  });
});

describe("GET /groups", () => {
  it("starts empty with enforcement on", async () => {
    const res = await call("/groups", "get");
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({ groups: [], enforce: true });
  });

  it("lists the stored groups", async () => {
    await seed(["KI5", "lib", "core"], ["Other", "x", "y"]);
    const body = (await call("/groups", "get")).getBody();
    expect(body.groups.map((g) => g.name)).toEqual(["KI5", "Other"]);
    expect(body.groups[0]).toMatchObject({ id: "seed-0", modIds: ["lib", "core"] });
  });
});

describe("POST /groups", () => {
  it("creates a group and answers 201 with the contract's shape", async () => {
    const res = await create({ name: "  KI5 Vehicles ", description: " Cars ", modIds: ["lib", "core", "addon"] });
    expect(res.getStatusCode()).toBe(201);
    const { group } = res.getBody();
    expect(group).toEqual({
      id: expect.any(String),
      name: "KI5 Vehicles",
      description: "Cars",
      modIds: ["lib", "core", "addon"],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(new Date(group.createdAt).toISOString()).toBe(group.createdAt);
    expect(group.updatedAt).toBe(group.createdAt);
    expect(await db.getModGroups()).toEqual([group]);
    expect((await call("/groups", "get")).getBody().groups).toEqual([group]);
  });

  it("makes the description optional and gives every group its own id", async () => {
    const a = (await create({ name: "A", modIds: ["x"] })).getBody().group;
    const b = (await create({ name: "A", modIds: ["x"] })).getBody().group;
    expect(a.description).toBe("");
    expect(a.id).not.toBe(b.id);
  });

  it("keeps all-digit mod ids and drops repeated ones", async () => {
    const { group } = (await create({ name: "Digits", modIds: ["3519629457", "b", "3519629457"] })).getBody();
    expect(group.modIds).toEqual(["3519629457", "b"]);
  });

  it("refuses an invalid field with MODS_GROUP_INVALID naming it, and stores nothing", async () => {
    const cases = [
      [{ modIds: ["a"] }, "name"],
      [{ name: "   ", modIds: ["a"] }, "name"],
      [{ name: "x".repeat(61), modIds: ["a"] }, "name"],
      [{ name: `bad${String.fromCharCode(0)}`, modIds: ["a"] }, "name"],
      [{ name: 5, modIds: ["a"] }, "name"],
      [{ name: "n", description: "d".repeat(301), modIds: ["a"] }, "description"],
      [{ name: "n", description: ["x"], modIds: ["a"] }, "description"],
      [{ name: "n" }, "modIds"],
      [{ name: "n", modIds: [] }, "modIds"],
      [{ name: "n", modIds: "a;b" }, "modIds"],
      [{ name: "n", modIds: ["a", 5] }, "modIds"],
      [{ name: "n", modIds: ["a;b"] }, "modIds"],
      [{ name: "n", modIds: ["a=b"] }, "modIds"],
      [{ name: "n", modIds: ["a", ""] }, "modIds"],
      [{ name: "n", modIds: ["x".repeat(201)] }, "modIds"],
      [{ name: "n", modIds: ids(501) }, "modIds"],
      [undefined, "name"],
    ];
    for (const [body, field] of cases) {
      const res = await create(body);
      expect(res.getStatusCode(), JSON.stringify(body)).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_GROUP_INVALID", params: { field } });
    }
    expect(await db.getModGroups()).toEqual([]);
  });

  it("accepts a group at the limits: 60-character name, 300-character description, 500 mods of 200 characters", async () => {
    const res = await create({
      name: "n".repeat(60),
      description: "d".repeat(300),
      modIds: ids(499).concat("m".repeat(200)),
    });
    expect(res.getStatusCode()).toBe(201);
    expect(res.getBody().group.modIds).toHaveLength(500);
  });

  it("stops at 100 groups with MODS_GROUP_LIMIT_REACHED (409)", async () => {
    await seed(...Array.from({ length: 99 }, (_, i) => [`G${i}`, "a", "b"]));
    expect((await create({ name: "The 100th", modIds: ["a"] })).getStatusCode()).toBe(201);

    const res = await create({ name: "The 101st", modIds: ["a"] });
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "MODS_GROUP_LIMIT_REACHED", params: { max: 100 } });
    expect(await db.getModGroups()).toHaveLength(100);
  });
});

describe("PUT /groups/:id", () => {
  beforeEach(async () => {
    await seed(["KI5", "lib", "core"], ["Other", "x", "y"]);
  });

  it("changes only the fields that are given", async () => {
    const before = (await db.getModGroups())[0];
    const res = await call("/groups/:id", "put", { params: { id: "seed-0" }, body: { name: " KI5 Cars " } });
    expect(res.getStatusCode()).toBe(200);
    const { group } = res.getBody();
    expect(group).toMatchObject({ id: "seed-0", name: "KI5 Cars", description: "", modIds: ["lib", "core"] });
    expect(group.createdAt).toBe(before.createdAt);
    expect(group.updatedAt).not.toBe("2026-10-01T00:00:00.000Z");
    expect(new Date(group.updatedAt).toISOString()).toBe(group.updatedAt);
  });

  it("replaces the order with a new modIds list and the description", async () => {
    const res = await call("/groups/:id", "put", {
      params: { id: "seed-0" },
      body: { modIds: ["core", "lib", "addon"], description: "Order matters" },
    });
    expect(res.getBody().group).toMatchObject({ name: "KI5", description: "Order matters", modIds: ["core", "lib", "addon"] });
  });

  it("leaves the other groups alone", async () => {
    await call("/groups/:id", "put", { params: { id: "seed-0" }, body: { name: "Renamed" } });
    expect((await db.getModGroups())[1]).toMatchObject({ name: "Other", modIds: ["x", "y"], updatedAt: "2026-10-01T00:00:00.000Z" });
  });

  it("answers 404 MODS_GROUP_NOT_FOUND for an unknown id", async () => {
    const res = await call("/groups/:id", "put", { params: { id: "nope" }, body: { name: "x" } });
    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody().code).toBe("MODS_GROUP_NOT_FOUND");
  });

  it("refuses an invalid given field and changes nothing", async () => {
    for (const [body, field] of [
      [{ name: "" }, "name"],
      [{ name: "x".repeat(61) }, "name"],
      [{ description: "d".repeat(301) }, "description"],
      [{ modIds: [] }, "modIds"],
      [{ modIds: ["a;b"] }, "modIds"],
    ]) {
      const res = await call("/groups/:id", "put", { params: { id: "seed-0" }, body });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_GROUP_INVALID", params: { field } });
    }
    expect((await db.getModGroups())[0]).toMatchObject({ name: "KI5", modIds: ["lib", "core"] });
  });
});

describe("DELETE /groups/:id", () => {
  it("removes the group and answers { success: true }", async () => {
    await seed(["A", "a"], ["B", "b"]);
    const res = await call("/groups/:id", "delete", { params: { id: "seed-0" } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({ success: true });
    expect((await db.getModGroups()).map((g) => g.name)).toEqual(["B"]);
  });

  it("answers 404 MODS_GROUP_NOT_FOUND for an unknown id", async () => {
    const res = await call("/groups/:id", "delete", { params: { id: "nope" } });
    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody().code).toBe("MODS_GROUP_NOT_FOUND");
  });
});

describe("POST /groups/import", () => {
  const doc = (extra = {}) => ({
    schema: 1,
    kind: "zcp-mod-group",
    name: "KI5 Vehicles",
    description: "Shared by an admin",
    modIds: ["lib", "core", "addon"],
    ...extra,
  });
  const importDoc = (document) => call("/groups/import", "post", { body: { document } });

  it("creates the group from a shared file", async () => {
    const res = await importDoc(doc());
    expect(res.getStatusCode()).toBe(201);
    expect(res.getBody().group).toMatchObject({
      name: "KI5 Vehicles",
      description: "Shared by an admin",
      modIds: ["lib", "core", "addon"],
    });
    expect(await db.getModGroups()).toHaveLength(1);
  });

  it("suffixes a name that is taken instead of failing", async () => {
    await seed(["KI5 Vehicles", "a", "b"]);
    expect((await importDoc(doc())).getBody().group.name).toBe("KI5 Vehicles (2)");
    expect((await importDoc(doc())).getBody().group.name).toBe("KI5 Vehicles (3)");
    expect((await importDoc(doc({ name: "ki5 vehicles" }))).getBody().group.name).toBe("ki5 vehicles (4)");
    expect((await db.getModGroups()).map((g) => g.name)).toEqual([
      "KI5 Vehicles",
      "KI5 Vehicles (2)",
      "KI5 Vehicles (3)",
      "ki5 vehicles (4)",
    ]);
  });

  it("keeps a suffixed name inside the 60-character limit", async () => {
    const long = "n".repeat(60);
    await seed([long, "a", "b"]);
    const { name } = (await importDoc(doc({ name: long }))).getBody().group;
    expect(name).toHaveLength(60);
    expect(name.endsWith(" (2)")).toBe(true);
  });

  it("refuses a document that is not a mod group export with MODS_GROUP_IMPORT_INVALID", async () => {
    const bad = [
      undefined,
      null,
      "text",
      [],
      doc({ kind: "zcp-preset" }),
      doc({ kind: undefined }),
      doc({ schema: 2 }),
      doc({ schema: undefined }),
      doc({ name: "" }),
      doc({ name: "x".repeat(61) }),
      doc({ description: "d".repeat(301) }),
      doc({ modIds: [] }),
      doc({ modIds: "lib" }),
      doc({ modIds: ["a;b"] }),
      doc({ modIds: ids(501) }),
    ];
    for (const document of bad) {
      const res = await importDoc(document);
      expect(res.getStatusCode(), JSON.stringify(document)).toBe(400);
      expect(res.getBody().code).toBe("MODS_GROUP_IMPORT_INVALID");
    }
    expect((await call("/groups/import", "post", { body: undefined })).getStatusCode()).toBe(400);
    expect(await db.getModGroups()).toEqual([]);
  });

  it("stops at 100 groups with MODS_GROUP_LIMIT_REACHED", async () => {
    await seed(...Array.from({ length: 100 }, (_, i) => [`G${i}`, "a", "b"]));
    const res = await importDoc(doc());
    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "MODS_GROUP_LIMIT_REACHED", params: { max: 100 } });
    expect(await db.getModGroups()).toHaveLength(100);
  });
});

describe("PUT /groups/enforce", () => {
  it("turns the enforcement off and on for the whole panel", async () => {
    let res = await call("/groups/enforce", "put", { body: { enforce: false } });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({ enforce: false });
    expect(await db.getSetting("modGroupsEnforce")).toBe(false);
    expect((await call("/groups", "get")).getBody().enforce).toBe(false);

    res = await call("/groups/enforce", "put", { body: { enforce: true } });
    expect(res.getBody()).toEqual({ enforce: true });
    expect((await call("/groups", "get")).getBody().enforce).toBe(true);
  });

  it("refuses anything but a boolean", async () => {
    for (const body of [undefined, {}, { enforce: "false" }, { enforce: 0 }, { enforce: null }]) {
      const res = await call("/groups/enforce", "put", { body });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "MODS_GROUP_INVALID", params: { field: "enforce" } });
    }
    expect(await db.getSetting("modGroupsEnforce")).toBeNull();
  });
});

describe("GET /groups/status", () => {
  it("evaluates every group against the current Mods= order", async () => {
    fx.writeIni("Mods=addon;x;lib;core\nWorkshopItems=1\n");
    await seed(["KI5", "lib", "core", "addon", "fix"], ["Fine", "x", "core"], ["Alone", "lib", "elsewhere"]);
    const res = await call("/groups/status", "get");
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({
      groups: [
        { id: "seed-0", inOrder: false, present: 3, total: 4, missing: ["fix"] },
        { id: "seed-1", inOrder: true, present: 2, total: 2, missing: [] },
        { id: "seed-2", inOrder: true, present: 1, total: 2, missing: ["elsewhere"] },
      ],
      inOrder: false,
      conflicts: [],
    });
  });

  it("says everything is in order when it is, and with no groups", async () => {
    expect((await call("/groups/status", "get")).getBody()).toEqual({ groups: [], inOrder: true, conflicts: [] });
    await seed(["G", "Alpha", "Beta"]);
    expect((await call("/groups/status", "get")).getBody()).toMatchObject({ inOrder: true, conflicts: [] });
  });

  it("names the groups that cannot be satisfied together", async () => {
    await seed(["One", "Alpha", "Beta"], ["Two", "Beta", "Alpha"]);
    const body = (await call("/groups/status", "get")).getBody();
    expect(body.conflicts).toEqual(["seed-0"]);
  });

  it("answers like the sibling routes when the ini cannot be read", async () => {
    fs.rmSync(fx.iniPath);
    let res = await call("/groups/status", "get");
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("MODS_SERVER_INI_NOT_FOUND");

    const state = await db.getDb();
    state.data.servers = [];
    res = await call("/groups/status", "get");
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("MODS_INVALID_SERVER_NAME");
  });
});

describe("POST /groups/apply", () => {
  const apply = (body) => call("/groups/apply", "post", { body });

  beforeEach(async () => {
    fx.writeIni("Mods=addon;x;lib;y;core\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n");
    await seed(["KI5", "lib", "core", "addon"]);
  });

  it("with preview: true reports the new order and writes nothing", async () => {
    const before = fx.readIni();
    const res = await apply({ preview: true });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual({
      changed: true,
      moved: ["lib", "core", "addon"],
      order: ["lib", "x", "core", "y", "addon"],
      written: false,
      conflicts: [],
    });
    expect(fx.readIni()).toBe(before);
    expect(fx.backups()).toEqual([]);
  });

  it("writes the new Mods= order through the lock and backup path, leaving the rest of the ini alone", async () => {
    const res = await apply({});
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({
      changed: true,
      moved: ["lib", "core", "addon"],
      order: ["lib", "x", "core", "y", "addon"],
      written: true,
      conflicts: [],
    });
    expect(modsLine()).toBe("lib;x;core;y;addon");
    expect(fx.readIni()).toBe("Mods=lib;x;core;y;addon\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n");
    expect(fx.backups()).toHaveLength(1);
  });

  it("treats a missing body like preview: false", async () => {
    const res = await call("/groups/apply", "post", { body: undefined });
    expect(res.getBody().written).toBe(true);
    expect(modsLine()).toBe("lib;x;core;y;addon");
  });

  it("does not write when nothing needs to move", async () => {
    await apply({});
    const backupsAfterFirst = fx.backups().length;
    const res = await apply({});
    expect(res.getBody()).toEqual({ changed: false, moved: [], order: ["lib", "x", "core", "y", "addon"], written: false, conflicts: [] });
    expect(fx.backups()).toHaveLength(backupsAfterFirst);
  });

  it("does not write when there are no groups", async () => {
    await seed();
    const before = fx.readIni();
    const res = await apply({});
    expect(res.getBody()).toMatchObject({ changed: false, written: false, moved: [] });
    expect(fx.readIni()).toBe(before);
    expect(fx.backups()).toEqual([]);
  });

  it("writes the entries as they were written, backslashes and all, only in the new order", async () => {
    fx.writeIni("Mods=\\addon; x ;\\lib;core\n");
    await apply({});
    expect(modsLine()).toBe("\\lib;x;core;\\addon");
  });

  it("keeps a numeric mod id", async () => {
    fx.writeIni("Mods=3519629457;lib\n");
    await seed(["Order", "lib", "3519629457"]);
    await apply({});
    expect(modsLine()).toBe("lib;3519629457");
  });

  it("reports groups that contradict each other and still writes the last pass", async () => {
    fx.writeIni("Mods=Alpha;Beta\n");
    await seed(["One", "Alpha", "Beta"], ["Two", "Beta", "Alpha"]);
    const res = await apply({});
    expect(res.getBody()).toMatchObject({ changed: true, written: true, conflicts: ["seed-0"], order: ["Beta", "Alpha"] });
    expect(modsLine()).toBe("Beta;Alpha");
  });

  it("answers like the sibling routes when the ini cannot be read, for a preview too", async () => {
    fs.rmSync(fx.iniPath);
    for (const body of [{ preview: true }, {}]) {
      const res = await apply(body);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe("MODS_SERVER_INI_NOT_FOUND");
    }
  });
});

describe("POST /save-order and mod groups", () => {
  const saveOrder = (modIds) => call("/save-order", "post", { body: { modIds } });

  beforeEach(async () => {
    await seed(["KI5", "lib", "core", "addon"]);
  });

  it("enforces the groups by default and says which mods it moved", async () => {
    const res = await saveOrder(["addon", "x", "core", "lib"]);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({
      message: "Mod load order saved successfully",
      modCount: 4,
      // core already sat in the slot it belongs in
      groupsAdjusted: ["lib", "addon"],
      groupConflicts: [],
    });
    expect(modsLine()).toBe("lib;x;core;addon");
  });

  it("writes an order that already satisfies the groups unchanged and reports nothing adjusted", async () => {
    const res = await saveOrder(["x", "lib", "y", "core", "addon"]);
    expect(res.getBody()).toMatchObject({ groupsAdjusted: [], groupConflicts: [] });
    expect(modsLine()).toBe("x;lib;y;core;addon");
  });

  it("leaves the client's order alone when enforcement is off", async () => {
    await call("/groups/enforce", "put", { body: { enforce: false } });
    const res = await saveOrder(["addon", "x", "core", "lib"]);
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ modCount: 4, groupsAdjusted: [], groupConflicts: [] });
    expect(modsLine()).toBe("addon;x;core;lib");
  });

  it("enforces again once it is turned back on", async () => {
    await call("/groups/enforce", "put", { body: { enforce: false } });
    await call("/groups/enforce", "put", { body: { enforce: true } });
    await saveOrder(["addon", "core", "lib"]);
    expect(modsLine()).toBe("lib;core;addon");
  });

  it("saves the order untouched when there are no groups", async () => {
    await seed();
    const res = await saveOrder(["b", "a"]);
    expect(res.getBody()).toMatchObject({ groupsAdjusted: [], groupConflicts: [] });
    expect(modsLine()).toBe("b;a");
  });

  it("reports contradicting groups in groupConflicts", async () => {
    await seed(["One", "Alpha", "Beta"], ["Two", "Beta", "Alpha"]);
    const res = await saveOrder(["Alpha", "Beta"]);
    expect(res.getBody().groupConflicts).toEqual(["seed-0"]);
    expect(modsLine()).toBe("Beta;Alpha");
  });

  it("keeps the other fields of the response and a numeric mod id", async () => {
    await seed(["Digits", "lib", "3519629457"]);
    const res = await saveOrder(["3519629457", "lib"]);
    expect(Object.keys(res.getBody()).sort()).toEqual(["groupConflicts", "groupsAdjusted", "message", "modCount"]);
    expect(modsLine()).toBe("lib;3519629457");
  });
});
