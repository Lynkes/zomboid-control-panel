import { ErrorCode } from "../utils/errorCodes.js";
import { FmError } from "./fileManagerContract.js";

// Server Files over the active remote profile's PanelBridge SFTP login.
// Placeholder from the v1.4.1 contract commit; the SFTP workstream replaces
// it. Until then no remote root can be opened.
export function createSftpBackend() {
  throw new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, 503, { reason: "remoteNotConfigured" });
}

// server/index.js calls this during graceful shutdown.
export async function closeFileManagerSftpPool() {}
