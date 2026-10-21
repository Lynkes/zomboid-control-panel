import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { recordPanelPort } from "../utils/panelPortFile.js";

// Both images' HEALTHCHECK fetched http://localhost:3001/api/health while the
// panel listens on PORT, else the port saved in Settings, else 3001 (or a
// free port it picked when that one was busy). A panel on any other port
// read as unhealthy, and the all-in-one updater rolls an update back on
// "unhealthy". The panel now records the port it really listens on in
// PANEL_PORT_FILE, and docker/healthcheck.cjs checks that one.

const require = createRequire(import.meta.url);
const { resolveHealthcheckPort, checkHealth, validPort } = require("../../docker/healthcheck.cjs");

const tempDirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-healthcheck-"));
  tempDirs.push(dir);
  return dir;
};
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fakePanel(status = 200) {
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === "/api/health" ? status : 404;
    response.end("{}");
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, resolve));
  return server.address().port;
}

describe("docker/healthcheck.cjs: which port it checks", () => {
  it("the port the panel recorded, whatever PORT says", () => {
    const file = path.join(tempDir(), "panel.port");
    fs.writeFileSync(file, "8080\n");
    expect(resolveHealthcheckPort({ PANEL_PORT_FILE: file })).toBe(8080);
    expect(resolveHealthcheckPort({ PANEL_PORT_FILE: file, PORT: "3001" })).toBe(8080);
  });

  it("PORT, then 3001, until the panel has recorded one", () => {
    const missing = path.join(tempDir(), "not-yet.port");
    expect(resolveHealthcheckPort({ PANEL_PORT_FILE: missing, PORT: "4000" })).toBe(4000);
    expect(resolveHealthcheckPort({ PANEL_PORT_FILE: missing })).toBe(3001);
    expect(resolveHealthcheckPort({ PORT: "4000" })).toBe(4000);
    expect(resolveHealthcheckPort({})).toBe(3001);
  });

  it.each(["", "0", "65536", "80a", "-1", "3001 3002", "1e3"])("ignores %j as a port, like the panel", (value) => {
    expect(validPort(value)).toBeNull();
    const file = path.join(tempDir(), "panel.port");
    fs.writeFileSync(file, value);
    expect(resolveHealthcheckPort({ PANEL_PORT_FILE: file, PORT: value })).toBe(3001);
  });
});

describe("docker/healthcheck.cjs: the check", () => {
  it("is healthy on a 200 from /api/health on that port, and not otherwise", async () => {
    const healthy = await fakePanel(200);
    const failing = await fakePanel(503);
    expect(await checkHealth(healthy)).toBe(true);
    expect(await checkHealth(failing)).toBe(false);
    // Nothing listens there any more.
    const closed = await fakePanel(200);
    await new Promise((resolve) => servers.pop().close(resolve));
    expect(await checkHealth(closed)).toBe(false);
  });

  it("exits 0 or 1 when Docker runs it", async () => {
    const script = require.resolve("../../docker/healthcheck.cjs");
    const { execFile } = await import("node:child_process");
    const port = await fakePanel(200);
    const file = path.join(tempDir(), "panel.port");
    fs.writeFileSync(file, `${port}\n`);
    // Asynchronously: a sync spawn would block the fake panel in this process.
    const run = (env) =>
      new Promise((resolve) => {
        execFile(process.execPath, [script], { env: { ...process.env, PORT: "", ...env } }, (error) => resolve(error ? error.code : 0));
      });
    expect(await run({ PANEL_PORT_FILE: file })).toBe(0);
    fs.writeFileSync(file, "1\n");
    expect(await run({ PANEL_PORT_FILE: file })).toBe(1);
  });

  it("finds a panel on a custom port through the file it recorded", async () => {
    const port = await fakePanel(200);
    const file = path.join(tempDir(), "panel.port");
    expect(recordPanelPort(port, { env: { PANEL_PORT_FILE: file } })).toBe(true);
    expect(await checkHealth(resolveHealthcheckPort({ PANEL_PORT_FILE: file }))).toBe(true);
  });
});

describe("recordPanelPort", () => {
  it("writes the port only when PANEL_PORT_FILE is set", () => {
    const file = path.join(tempDir(), "panel.port");
    expect(recordPanelPort(8080, { env: {} })).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(recordPanelPort(8080, { env: { PANEL_PORT_FILE: file } })).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("8080\n");
    // Replaced on the next start, with no temp file left behind.
    expect(recordPanelPort(8081, { env: { PANEL_PORT_FILE: file } })).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("8081\n");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["panel.port"]);
  });

  it("refuses a value that isn't a port, and only warns when it can't write", () => {
    const file = path.join(tempDir(), "panel.port");
    expect(recordPanelPort(0, { env: { PANEL_PORT_FILE: file } })).toBe(false);
    expect(recordPanelPort("8080", { env: { PANEL_PORT_FILE: file } })).toBe(false);
    const warn = vi.fn();
    const unwritable = path.join(tempDir(), "missing-dir", "panel.port");
    expect(recordPanelPort(8080, { env: { PANEL_PORT_FILE: unwritable }, log: { warn } })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not record the panel port"));
  });

  it("is called with the port the panel actually bound", () => {
    const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
    expect(index).toMatch(/activePanelPort = boundPort;\s*\n(?:\s*\/\/[^\n]*\n)*\s*recordPanelPort\(boundPort, \{ log \}\);/);
  });
});

describe("both images use it", () => {
  const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

  it.each(["Dockerfile", "docker/all-in-one/Dockerfile"])("%s", (file) => {
    const text = read(file);
    expect(text).not.toMatch(/localhost:3001\/api\/health/);
    expect(text).toContain("COPY docker/healthcheck.cjs /usr/local/lib/zomboid-panel/healthcheck.cjs");
    expect(text).toContain('CMD ["node", "/usr/local/lib/zomboid-panel/healthcheck.cjs"]');
    expect(text).toMatch(/PANEL_PORT_FILE=\/tmp\/zomboid-panel\.port/);
  });

  it.each(["docker/entrypoint.sh", "docker/all-in-one/entrypoint.sh"])("%s drops a port file left by an earlier start", (file) => {
    expect(read(file)).toMatch(/rm -f -- "\$PANEL_PORT_FILE"/);
  });
});
