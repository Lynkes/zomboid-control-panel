import fs from "fs";
import os from "os";
import path from "path";

// Shared scaffolding for the tests that drive server/routes/mods.js handlers
// directly (no HTTP): a runner for a router's registered handler stack and a
// throwaway "server" on disk -- data folder, <name>.ini, install folder with
// workshop content -- that satisfies the data-folder rule.

export function createResponse() {
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

export function createRouteRunner(router) {
  function getRouteHandlers(routePath, method) {
    const layer = router.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods[method],
    );
    if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
    return layer.route.stack.map((s) => s.handle);
  }

  return async function runRoute(routePath, method, req) {
    const handlers = getRouteHandlers(routePath, method);
    const res = createResponse();
    let idx = -1;
    const next = async (err) => {
      idx++;
      if (err) throw err;
      if (idx < handlers.length) await handlers[idx](req, res, next);
    };
    await next();
    return res;
  };
}

/**
 * A throwaway server layout under os.tmpdir():
 *   <root>/Server/<name>.ini      the server config
 *   <root>/install/steamapps/workshop/content/108600/<wsId>/mods/<folder>/mod.info
 * `activeServer` is what the mocked getActiveServer() should resolve to.
 */
export function makeServerFixture({ prefix = "mods-fixture-", serverName = "TestServer", ini = "" } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(dataRoot, "Server");
  fs.mkdirSync(configPath, { recursive: true });
  // The data folder is held to the data-folder rule: a Saves folder counts
  // only with a world save in it.
  fs.mkdirSync(path.join(dataRoot, "Saves", "Multiplayer", "World"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "Saves", "Multiplayer", "World", "map_t.bin"), "");
  const iniPath = path.join(configPath, `${serverName}.ini`);
  fs.writeFileSync(iniPath, ini);
  const installPath = path.join(dataRoot, "install");
  fs.mkdirSync(installPath, { recursive: true });

  const workshopContent = path.join(installPath, "steamapps", "workshop", "content", "108600");

  return {
    dataRoot,
    configPath,
    iniPath,
    installPath,
    serverName,
    activeServer: {
      id: "server-1",
      zomboidDataPath: dataRoot,
      serverConfigPath: configPath,
      serverName,
      installPath,
      isRemote: false,
    },
    readIni: () => fs.readFileSync(iniPath, "utf-8"),
    writeIni: (content) => fs.writeFileSync(iniPath, content),
    iniValue: (key) => {
      const text = fs.readFileSync(iniPath, "utf-8");
      const m = text.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, "m"));
      return m ? m[1] : null;
    },
    backups: () => {
      const dir = path.join(configPath, "backups");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".bak")) : [];
    },
    workshopFolder: (wsId) => path.join(workshopContent, String(wsId)),
    /** Writes <workshop>/<wsId>/mods/<folder>/<subdir?>/mod.info and returns the mod folder. */
    writeMod(wsId, folder, modInfo, subdir = "") {
      const dir = path.join(workshopContent, String(wsId), "mods", folder, subdir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "mod.info"), modInfo);
      return path.join(workshopContent, String(wsId), "mods", folder);
    },
    cleanup() {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
