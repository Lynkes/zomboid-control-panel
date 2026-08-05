// Cross-checks every PanelBridge action the Events page can send against the
// deployed Lua handlers and the server-side allow-list. Reports only mismatches.
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const lua = read("pz-mod/PanelBridge/media/lua/server/PanelBridge.lua");
const luaHandlers = new Set(
  [...lua.matchAll(/^\s*handlers\.([a-zA-Z]+)/gm)].map((m) => m[1]),
);

const routes = read("server/routes/panelBridge.js");
const validBlock = routes.slice(routes.indexOf("const VALID_ACTIONS"));
const allowList = new Set(
  [...validBlock.slice(0, validBlock.indexOf("]);")).matchAll(/"([a-zA-Z]+)"/g)].map(
    (m) => m[1],
  ),
);

// Every action name the client can put on the wire, from the API layer.
const api = read("client/src/lib/api.ts");
const apiActions = new Set(
  [...api.matchAll(/sendCommand\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
);
for (const m of api.matchAll(/apiPost\(\s*"\/panel-bridge\/command",\s*\{\s*action:\s*"([a-zA-Z]+)"/g)) {
  apiActions.add(m[1]);
}

const events = read("client/src/pages/Events.tsx");
const eventsOps = new Set(
  [...events.matchAll(/sendCommand\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1]),
);
const templatesBlock = events.slice(
  events.indexOf("const bridgeOperationTemplates"),
);
for (const m of templatesBlock
  .slice(0, templatesBlock.indexOf("\n}"))
  .matchAll(/^\s{2}([a-zA-Z]+):\s*\{/gm)) {
  eventsOps.add(m[1]);
}

const candidates = new Set([...apiActions, ...eventsOps]);
const missingHandler = [...candidates].filter((a) => !luaHandlers.has(a)).sort();
const missingAllow = [...candidates].filter((a) => !allowList.has(a)).sort();
const allowedButUnimplemented = [...allowList]
  .filter((a) => !luaHandlers.has(a))
  .sort();

console.log(`checked actions:            ${candidates.size}`);
console.log(`lua handlers:               ${luaHandlers.size}`);
console.log(`server allow-list:          ${allowList.size}`);
console.log(`NO LUA HANDLER:             ${missingHandler.join(", ") || "none"}`);
console.log(`NOT IN ALLOW-LIST:          ${missingAllow.join(", ") || "none"}`);
console.log(`ALLOWED BUT NO HANDLER:     ${allowedButUnimplemented.join(", ") || "none"}`);
