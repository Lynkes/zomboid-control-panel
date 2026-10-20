import { ErrorCode } from "./errorCodes.js";
import { isMaskedSecret } from "./sanitize.js";

// SECURITY (2026-10-20): the saved PanelBridge SFTP password was entered for
// the saved host, port and account, and it goes nowhere else. A request that
// names another target brings its own password; before, the SFTP routes put
// the saved one in for any host the caller named, so a bridge.setup role
// (which cannot read the password) could have the panel log in to a host of
// its choice with it. Same rule as OIDC's saved client secret, which is
// used only with the saved issuer (routes/oidc.js).

export const SFTP_PASSWORD_REQUIRED_MESSAGE =
  "Enter the SFTP password for this host. The saved password is only used with the saved host, port and username.";

export class SftpPasswordRequiredError extends Error {
  constructor() {
    super(SFTP_PASSWORD_REQUIRED_MESSAGE);
    this.name = "SftpPasswordRequiredError";
    this.code = ErrorCode.SFTP_PASSWORD_REQUIRED;
    this.status = 400;
  }
}

// A connection target as the connection and the host-key pin store
// (services/sftpHostKeys.js) read it: host names compare without case or
// surrounding blanks, an empty port is 22. Anything that isn't a string
// never matches.
export function sftpTargetOf(host, port, username) {
  return {
    host: typeof host === "string" ? host.trim().toLowerCase() : null,
    port: port === undefined || port === null || port === "" ? 22 : Number(port),
    username: typeof username === "string" ? username.trim() : null,
  };
}

export function sameSftpTarget(a, b) {
  return (
    Boolean(a.host) &&
    a.host === b.host &&
    Number.isInteger(a.port) &&
    a.port === b.port &&
    Boolean(a.username) &&
    a.username === b.username
  );
}

/** A password the caller typed: a non-empty string that isn't the mask. */
export function isSuppliedSftpPassword(value) {
  return typeof value === "string" && value.length > 0 && !isMaskedSecret(value);
}

/**
 * The password a request's SFTP connection uses: the one in the request, or
 * the saved one when the request's host, port and username (each falling
 * back to the saved value when left out) are the saved ones. Throws
 * SftpPasswordRequiredError when a password is saved and the request names
 * another target without bringing one.
 */
export function sftpPasswordForRequest(input, saved) {
  if (isSuppliedSftpPassword(input?.password)) return input.password;
  const savedPassword = saved?.password || "";
  if (!savedPassword) return "";
  const requested = sftpTargetOf(
    input?.host ?? saved.host,
    input?.port ?? saved.port,
    input?.username ?? saved.username,
  );
  if (!sameSftpTarget(requested, sftpTargetOf(saved.host, saved.port, saved.username))) {
    throw new SftpPasswordRequiredError();
  }
  return savedPassword;
}
