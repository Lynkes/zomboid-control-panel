import { describe, it } from "vitest";
import { runBackendConformance } from "./helpers/fileBackendConformance.js";
import { SFTP_SERVER_REQUIRED, sftpServerSkipReason, startOpensshSftpServer } from "./helpers/opensshSftpServer.js";

// The SFTP backend against the shared FileBackend contract, over a REAL
// OpenSSH sftp-server (helpers/opensshSftpServer.js) reached through the
// panel's real ssh2-sftp-client: the same suite the local backend and the
// in-memory fake pass (fileManagerLocalConformance.test.js,
// fileManagerSftpConformance.test.js), with nobody's model of OpenSSH in
// between. Each test gets a fresh server, folder and connection pool.

const { createSftpBackend, closeFileManagerSftpPool } = await import("../services/fileManagerSftpBackend.js");
const { _setFileManagerSftpTestHooks } = await import("../services/fileManagerSftpPool.js");

if (sftpServerSkipReason) {
  (SFTP_SERVER_REQUIRED ? describe : describe.skip)(`FileBackend conformance: sftp over real OpenSSH (${sftpServerSkipReason})`, () => {
    it("needs an sftp-server binary", () => {
      throw new Error(sftpServerSkipReason);
    });
  });
} else {
  // `throughLink`: the root is configured through a link to the folder (a
  // junction on Windows), so its real path, which REALPATH gives, isn't the
  // path it was configured as.
  const makeBackend = (throughLink) => async () => {
    const srv = await startOpensshSftpServer();
    srv.fs.mkdir("Zomboid");
    const at = (rel) => (rel ? `Zomboid/${rel}` : "Zomboid");
    _setFileManagerSftpTestHooks({ timeouts: { transferIdleMs: 5000, opMs: 10000, readyMs: 10000 } });
    const backend = createSftpBackend({ settings: srv.settings });
    const rootPath = throughLink ? `${srv.aliasRoot()}/Zomboid` : srv.remote("Zomboid");
    return {
      backend,
      root: { id: "data", path: rootPath, warnings: [] },
      seed: {
        mkdir: (rel) => srv.fs.mkdir(at(rel)),
        writeFile: (rel, content) => srv.fs.writeFile(at(rel), content),
        readFile: (rel) => srv.fs.readFile(at(rel))?.toString("utf8") ?? null,
        exists: (rel) => srv.fs.exists(at(rel)),
      },
      cleanup: async () => {
        await closeFileManagerSftpPool();
        _setFileManagerSftpTestHooks();
        await srv.close();
      },
    };
  };
  runBackendConformance("sftp over real OpenSSH", makeBackend(false));
  runBackendConformance("sftp over real OpenSSH, the root reached through a link", makeBackend(true));
}
