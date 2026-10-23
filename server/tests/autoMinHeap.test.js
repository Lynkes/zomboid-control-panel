import { afterEach, describe, expect, it } from "vitest";
import { createServer, deleteServer, getServer, getSetting, setSetting, updateServer } from "../database/init.js";
import { normalizeMinMemoryGb } from "../utils/memory.js";

// ZGC never hands memory back below -Xms, so a server whose minimum was
// above what it really uses held the difference for good (2026-10-07, two
// servers in the all-in-one container: one at -Xms2g showed ~480 MB "Free"
// in the in-game stats, all of it resident). A minimum of 0 now means no
// -Xms at all. It used to come back as 4 GB: normalizeMemoryGb() reads 0 as
// "no value".

const { generateStartupScripts } = await import("../routes/server.js");
const { default: configRouter } = await import("../routes/config.js");

describe("normalizeMinMemoryGb()", () => {
  it("keeps 0, as a number or as text", () => {
    expect(normalizeMinMemoryGb(0, 4)).toBe(0);
    expect(normalizeMinMemoryGb("0", 4)).toBe(0);
    expect(normalizeMinMemoryGb(" 00 ", 4)).toBe(0);
  });

  it("reads anything else the way normalizeMemoryGb() does", () => {
    expect(normalizeMinMemoryGb(2, 4)).toBe(2);
    expect(normalizeMinMemoryGb("8", 4)).toBe(8);
    expect(normalizeMinMemoryGb(4096, 4)).toBe(4);
    for (const missing of [undefined, null, "", -1, "junk"]) {
      expect(normalizeMinMemoryGb(missing, 4)).toBe(4);
    }
  });
});

describe("generateStartupScripts(): minimum memory", () => {
  const base = {
    installPath: "/pz-server",
    serverName: "Auto",
    maxMemory: 16,
    zomboidDataPath: "/zomboid",
    adminPassword: "pw",
  };

  it("leaves -Xms out for a minimum of 0, keeping -Xmx and the soft limit", () => {
    const { sh, bat } = generateStartupScripts({ ...base, minMemory: 0 });

    for (const script of [sh, bat]) {
      expect(script).not.toMatch(/-Xms/);
      expect(script).toContain("-Xmx16g");
      expect(script).toContain("-XX:SoftMaxHeapSize=10g");
      expect(script).toContain("Memory: auto - 16GB");
    }
  });

  it("still passes a minimum above 0 as -Xms", () => {
    const { sh, bat } = generateStartupScripts({ ...base, minMemory: 2 });

    expect(sh).toContain("-Xms2g -Xmx16g");
    expect(bat).toContain("-Xms2g -Xmx16g");
    expect(sh).toContain("Memory: 2GB - 16GB");
  });
});

describe("a saved minimum of 0", () => {
  const created = [];

  afterEach(async () => {
    for (const id of created.splice(0)) await deleteServer(id).catch(() => {});
  });

  it("stays 0 through create, update and read", async () => {
    const server = await createServer({ name: "AutoHeap", serverName: "AutoHeap", minMemory: 0, maxMemory: 8 });
    created.push(server.id);
    expect(server.minMemory).toBe(0);

    await updateServer(server.id, { minMemory: 2 });
    await updateServer(server.id, { minMemory: 0 });

    expect((await getServer(server.id)).minMemory).toBe(0);
  });

  it("is accepted by PUT /app-settings, which Settings' Save sends back with the active server's copy", async () => {
    const layer = configRouter.stack.find(
      (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    let statusCode = 200;
    const res = {
      status(code) {
        statusCode = code;
        return res;
      },
      json() {
        return res;
      },
    };

    const before = await getSetting("minMemory");
    try {
      await handler({ body: { settings: { minMemory: 0 } }, app: { get: () => undefined }, user: null }, res);

      expect(statusCode).toBe(200);
      expect(await getSetting("minMemory")).toBe(0);
    } finally {
      await setSetting("minMemory", before);
    }
  });
});
