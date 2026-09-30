// Confirmation tokens (spec §A8). The server alone decides which tokens a
// mutation needs; the client learns them from FM_CONFIRMATION_REQUIRED (or a
// preflight/preview's `required`), asks the operator once, and repeats the
// request with them. Nothing is cached server-side: every request is checked.
import { ErrorCode } from "../utils/errorCodes.js";
import { CONFIRM_TOKENS, FmError } from "./fileManagerContract.js";
import { extensionOf } from "./fileManagerTextCodec.js";

// Creating or replacing one of these runs code under the server's account at
// its next start.
const EXECUTABLE_EXTENSIONS = new Set([".jar", ".class", ".dll", ".so", ".exe", ".bat", ".cmd", ".ps1", ".sh"]);
const EXECUTABLE_NAMES = new Set(["projectzomboid64.json", "projectzomboid32.json"]);

export function isExecutableName(name) {
  const lower = String(name || "").toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(extensionOf(lower))) return true;
  if (EXECUTABLE_NAMES.has(lower)) return true;
  if (lower.startsWith("startserver") && lower.endsWith(".bat")) return true;
  if (lower.startsWith("start-server") && lower.endsWith(".sh")) return true;
  return false;
}

/**
 * Parse the `confirm` field of a JSON body. Absent means none; anything but
 * an array of known tokens is a bad request.
 * @returns {string[]}
 */
export function parseConfirmField(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > CONFIRM_TOKENS.length * 2) {
    throw new FmError(ErrorCode.FM_INVALID_REQUEST, undefined, { field: "confirm" });
  }
  const tokens = [];
  for (const token of value) {
    if (typeof token !== "string" || !CONFIRM_TOKENS.includes(token)) {
      throw new FmError(ErrorCode.FM_INVALID_REQUEST, undefined, { field: "confirm" });
    }
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

// The upload's X-File-Confirm header: comma-separated tokens.
export function parseConfirmHeader(value) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string" || value.length > 200) {
    throw new FmError(ErrorCode.FM_INVALID_REQUEST, undefined, { field: "confirm" });
  }
  return parseConfirmField(
    value
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

/**
 * Accumulates what one request needs confirmed, then checks it in one go so
 * the operator sees every reason in a single prompt.
 */
export class ConfirmationSet {
  constructor() {
    /** @type {Set<string>} */
    this.tokens = new Set();
    this.serverState = null;
    this.executableNames = [];
    this.overwriteNames = [];
  }

  requireServerRunning(state) {
    this.tokens.add("serverRunning");
    // "running" outranks "unknown" when several states contributed.
    if (this.serverState !== "running") this.serverState = state;
  }

  requireExecutable(name) {
    this.tokens.add("executable");
    if (!this.executableNames.includes(name) && this.executableNames.length < 20) this.executableNames.push(name);
  }

  requireOverwrite(name) {
    this.tokens.add("overwrite");
    if (!this.overwriteNames.includes(name) && this.overwriteNames.length < 20) this.overwriteNames.push(name);
  }

  requirePermanent() {
    this.tokens.add("permanent");
  }

  /** Tokens in the contract's order. */
  get required() {
    return CONFIRM_TOKENS.filter((token) => this.tokens.has(token));
  }

  details() {
    const details = {};
    if (this.serverState) details.serverState = this.serverState;
    if (this.executableNames.length) details.executable = { names: [...this.executableNames] };
    if (this.overwriteNames.length) details.overwrite = { names: [...this.overwriteNames] };
    return details;
  }

  /** Throws FM_CONFIRMATION_REQUIRED unless every required token was given. */
  assertConfirmed(provided) {
    const given = new Set(provided || []);
    const required = this.required;
    if (required.every((token) => given.has(token))) return;
    const error = new FmError(ErrorCode.FM_CONFIRMATION_REQUIRED, undefined, { required });
    error.details = this.details();
    throw error;
  }
}
