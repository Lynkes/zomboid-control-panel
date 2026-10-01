import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Every filesystem call the file manager makes on a request-derived path
// lives in services/fileManagerLocalFs.js (spec §A15), where each one
// carries its CodeQL justification. The Trash module may touch its own
// panel-owned meta.json, and the janitor may use fs; nothing else in
// services/fileManager*.js or routes/files.js may import or call fs at all,
// so a new sink can't appear somewhere unreviewed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");
const SERVICES_DIR = path.join(SERVER_DIR, "services");

const ALLOWED = new Set(["fileManagerLocalFs.js", "fileManagerTrash.js", "fileManagerJanitor.js"]);
const FS_IMPORT_RE = /(?:from\s+["'](?:node:)?fs(?:\/promises)?["']|require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)|import\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\))/;
const FS_CALL_RE = /\bfs\./;
// fs functions that take a path (the js/path-injection sinks).
const PATH_SINK_RE =
  /\bfs\.(realpathSync(?:\.native)?|lstatSync|statSync|accessSync|opendirSync|openSync|renameSync|linkSync|unlinkSync|rmdirSync|mkdirSync|chmodSync|lchownSync|writeFileSync|readFileSync|copyFileSync|readdirSync|rmSync)\(/;

function codeLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
}

const files = [
  ...fs
    .readdirSync(SERVICES_DIR)
    .filter((name) => name.startsWith("fileManager") && name.endsWith(".js"))
    .map((name) => ({ name, full: path.join(SERVICES_DIR, name) })),
  { name: "files.js", full: path.join(SERVER_DIR, "routes", "files.js") },
];

describe("Server Files: filesystem calls stay in fileManagerLocalFs.js", () => {
  it("scans the real files (sanity check)", () => {
    const names = files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["fileManagerLocalFs.js", "fileManagerService.js", "files.js"]));
  });

  it("no other file-manager module imports or calls fs", () => {
    const offenders = [];
    for (const file of files) {
      if (ALLOWED.has(file.name)) continue;
      codeLines(fs.readFileSync(file.full, "utf8")).forEach((line, index) => {
        if (FS_IMPORT_RE.test(line) || FS_CALL_RE.test(line)) offenders.push(`${file.name}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `filesystem access outside fileManagerLocalFs.js:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("every path-taking fs call in fileManagerLocalFs.js carries its justification", () => {
    const raw = fs.readFileSync(path.join(SERVICES_DIR, "fileManagerLocalFs.js"), "utf8").split(/\r?\n/);
    const code = codeLines(raw.join("\n"));
    const missing = [];
    code.forEach((line, index) => {
      if (!PATH_SINK_RE.test(line)) return;
      const above = raw[index - 1] || "";
      if (!/codeql\[js\/path-injection/.test(above) && !/panel-owned/.test(above)) {
        missing.push(`fileManagerLocalFs.js:${index + 1}: ${line.trim()}`);
      }
    });
    expect(missing, `fs sinks without a justification comment:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the Trash module's own fs calls only touch meta.json", () => {
    const lines = codeLines(fs.readFileSync(path.join(SERVICES_DIR, "fileManagerTrash.js"), "utf8"));
    const offenders = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => FS_CALL_RE.test(line) && !/meta/i.test(line))
      .map(({ line, index }) => `fileManagerTrash.js:${index + 1}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("the check itself catches a stray fs call (positive control)", () => {
    const sample = codeLines('import fs from "fs";\nconst x = fs.readFileSync(p);\n// fs.readFileSync(in a comment)');
    expect(sample.filter((line) => FS_IMPORT_RE.test(line) || FS_CALL_RE.test(line))).toHaveLength(2);
  });
});
