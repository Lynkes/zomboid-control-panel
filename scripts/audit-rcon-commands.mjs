// Extracts every literal RCON command the server routes send and compares it
// against the command list reported by the live server (rcon "help").
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const supportedFile = process.argv[3];
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const supported = new Set(
  fs
    .readFileSync(supportedFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
);

const files = [
  "server/services/rcon.js",
  "server/routes/server.js",
  "server/services/scheduler.js",
];
const found = new Map();

const patterns = [
  /this\.execute\(\s*[`"']([a-zA-Z]+)/g,
  /execute\w*\(\s*[`"']([a-zA-Z]+)/g,
  /rconService\.execute\(\s*[`"']([a-zA-Z]+)/g,
];

for (const file of files) {
  let text;
  try {
    text = read(file);
  } catch {
    continue;
  }
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
}

const unsupported = [...found.keys()].filter((c) => !supported.has(c)).sort();
const ok = [...found.keys()].filter((c) => supported.has(c)).sort();

console.log(`server reports ${supported.size} commands`);
console.log(`panel sends ${found.size} distinct commands`);
console.log(`VERIFIED: ${ok.join(", ")}`);
console.log(`NOT IN SERVER COMMAND LIST: ${unsupported.length ? unsupported.map((c) => `${c} (${found.get(c)})`).join(", ") : "none"}`);
