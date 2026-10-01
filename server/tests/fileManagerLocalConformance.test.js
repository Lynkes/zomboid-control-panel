import fs from "fs";
import path from "path";
import { runBackendConformance } from "./helpers/fileBackendConformance.js";
import { makeTempDir, removeDir } from "./helpers/fileManagerFixtures.js";

// The local backend against the shared FileBackend contract (the SFTP
// backend runs the same suite against its in-memory fake).

const { localBackend } = await import("../services/fileManagerLocalBackend.js");

runBackendConformance("local", async () => {
  const base = makeTempDir();
  const rootPath = path.join(base, "root");
  fs.mkdirSync(rootPath);
  const abs = (rel) => path.join(rootPath, ...rel.split("/"));
  return {
    backend: localBackend,
    root: { id: "data", path: rootPath },
    seed: {
      mkdir: (rel) => fs.mkdirSync(abs(rel), { recursive: true }),
      writeFile: (rel, content) => fs.writeFileSync(abs(rel), content),
      readFile: (rel) => (fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), "utf8") : null),
      exists: (rel) => fs.existsSync(abs(rel)),
    },
    cleanup: () => removeDir(base),
  };
});
