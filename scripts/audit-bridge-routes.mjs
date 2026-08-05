// Follows every /panel-bridge/* REST route to the bridge action it sends, then
// verifies that action exists in the deployed Lua mod. Reports only mismatches.
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const lua = read("pz-mod/PanelBridge/media/lua/server/PanelBridge.lua");
const luaHandlers = new Set(
  [...lua.matchAll(/^\s*handlers\.([a-zA-Z]+)/gm)].map((m) => m[1]),
);

const routes = read("server/routes/panelBridge.js");

// Split the route file per router.<verb>("<path>" so each action reference can
// be attributed to the endpoint that sends it.
const segments = [];
const routeRe = /router\.(get|post|put|delete)\(\s*"([^"]+)"/g;
let match;
const marks = [];
while ((match = routeRe.exec(routes)) !== null) {
  marks.push({ index: match.index, path: match[2] });
}
for (let i = 0; i < marks.length; i++) {
  segments.push({
    path: marks[i].path,
    body: routes.slice(marks[i].index, marks[i + 1]?.index ?? routes.length),
  });
}

const problems = [];
const verified = [];
for (const segment of segments) {
  const actions = new Set(
    [...segment.body.matchAll(/sendCommand\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
  );
  for (const m of segment.body.matchAll(/executeAction\(\s*"([a-zA-Z]+)"/g)) {
    actions.add(m[1]);
  }
  for (const action of actions) {
    if (luaHandlers.has(action)) verified.push(`${segment.path} -> ${action}`);
    else problems.push(`${segment.path} -> ${action}  (NO LUA HANDLER)`);
  }
}

console.log(`lua handlers implemented: ${luaHandlers.size}`);
console.log(`route->action pairs ok:   ${verified.length}`);
console.log(`MISMATCHES:               ${problems.length}`);
for (const p of problems) console.log(`  ${p}`);
