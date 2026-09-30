import { ErrorCode } from "../utils/errorCodes.js";
import { FmError } from "./fileManagerContract.js";

// Remote Server Files roots, derived from the active remote profile's SFTP
// settings. Placeholder from the v1.4.1 contract commit; the SFTP workstream
// replaces it. Until then a remote profile offers no roots.
export function resolveRemoteRoots() {
  return { roots: [], unavailable: { reason: "remoteNotConfigured" }, remote: null, derivedDataPath: null };
}

export function validateRemoteRootPath() {
  throw new FmError(ErrorCode.FM_INVALID_PATH);
}
