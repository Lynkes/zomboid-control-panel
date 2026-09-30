import { runBackendConformance } from "./helpers/fileBackendConformance.js";

// The SFTP backend against the shared FileBackend contract, over the
// in-memory fake SFTP server (the local backend runs the same suite in
// fileManagerLocalConformance.test.js). Each test gets a fresh fake server
// and a fresh connection pool.

const { closeFileManagerSftpPool } = await import("../services/fileManagerSftpBackend.js");
const { createFakeSftpFixture } = await import("./helpers/fakeSftp.js");

runBackendConformance("sftp", async () => {
  const fixture = await createFakeSftpFixture({ rootPath: "/srv/pz/Zomboid" });
  return {
    backend: fixture.backend,
    root: fixture.spec,
    seed: {
      mkdir: (rel) => fixture.seed.dir(rel),
      writeFile: (rel, content) => fixture.seed.file(rel, content),
      readFile: (rel) => fixture.read(rel)?.toString("utf8") ?? null,
      exists: (rel) => fixture.exists(rel),
    },
    cleanup: async () => {
      await closeFileManagerSftpPool();
      fixture.cleanup();
    },
  };
});
