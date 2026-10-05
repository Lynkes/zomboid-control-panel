import { getRoleByName } from "../services/permissions.js";
import { sanitizeError } from "./sanitize.js";

// SECURITY (2026-10-04, security sweep adversary pass): the server-record
// reads every role's pages use -- GET /api/servers, /active and /:id, and
// GET /api/server/status -- have no capability gate, and they returned each
// server's host folders and launch command as stored. GET /app-settings
// already hides the legacy copies of the same folders from a role that
// can't change them (SETTINGS_KEY_CAPABILITY maps them to servers.manage),
// so a moderator read them here instead: /opt/pz/prod-install,
// /home/operator/Zomboid and so on.
//
// A role that sets these up keeps them: servers.manage edits them,
// server.install and bridge.setup work with them, and panel.settings
// already sees the legacy copies in app settings. Every other role gets the
// same fixed placeholder masked secrets use, which still reads as "set" to
// a page that only checks whether a value is there (the Console's log
// source, for one), and says nothing about the folder.
export const HOST_PATH_FIELDS = Object.freeze([
  "installPath",
  "serverPath",
  "zomboidDataPath",
  "serverConfigPath",
  "startCommand",
]);

export const HOST_PATH_CAPABILITIES = Object.freeze([
  "servers.manage",
  "server.install",
  "bridge.setup",
  "panel.settings",
]);

export const HIDDEN_HOST_PATH = "••••••••";

// Fails closed: a caller whose role can't be resolved sees placeholders.
// `alsoCapabilities` adds the roles one read's own job needs the folders for.
export async function canSeeHostPaths(user, alsoCapabilities = []) {
  if (!user) return false;
  try {
    const role = await getRoleByName(user.role);
    const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
    return [...HOST_PATH_CAPABILITIES, ...alsoCapabilities].some((capability) =>
      capabilities.includes(capability),
    );
  } catch {
    return false;
  }
}

// SECURITY (2026-10-05, H4 round 3): the same rule for the reads a custom
// role reaches through a capability that works with the server's folders
// without setting them up: bridge.diagnostics (GET /api/panel-bridge/status
// and the panelBridge:* socket events), mods.manage (the Workshop ACF and
// the ini the Mods page edits), serverfiles.manage (Server Config's files),
// the four that read GET /api/bridge-delivery, and automation.manage
// (Schedule History). /api/servers already gave those roles the placeholder
// for the same folders, and these reads named them anyway.
//
// For a role that can't see them, a folder becomes the placeholder, a file
// keeps only its name (Server Config still says which file it edits), and
// free text -- an error, a log line -- is path-redacted like every error.
export function hideHostFolder(value) {
  return typeof value === "string" && value ? HIDDEN_HOST_PATH : value;
}

// The last name of a path in either slash style: a remote server's Windows
// path reaches a Linux panel too.
export function hostFileName(value) {
  if (typeof value !== "string" || !value) return value;
  return value.split(/[\\/]+/).filter(Boolean).pop() ?? HIDDEN_HOST_PATH;
}

function redactHostText(value) {
  return typeof value === "string" && value ? sanitizeError(value) : value;
}

// Every string in a JSON-shaped value, path-redacted: a response a
// path-free role reads whole, so a field added later is covered too.
function redactHostTextDeep(value) {
  if (typeof value === "string") return redactHostText(value);
  if (Array.isArray(value)) return value.map(redactHostTextDeep);
  const proto = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto === Object.prototype || proto === null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactHostTextDeep(item)]));
  }
  return value;
}

const identity = (value) => value;
const FULL_VIEW = Object.freeze({ full: true, folder: identity, file: identity, text: identity, deep: identity });
const MASKED_VIEW = Object.freeze({
  full: false,
  folder: hideHostFolder,
  file: hostFileName,
  text: redactHostText,
  deep: redactHostTextDeep,
});

// How one caller sees host folders, resolved once per request.
export async function hostPathViewFor(user, alsoCapabilities = []) {
  return (await canSeeHostPaths(user, alsoCapabilities)) ? FULL_VIEW : MASKED_VIEW;
}

export function hideHostPaths(record) {
  if (!record || typeof record !== "object") return record;
  const view = { ...record };
  for (const field of HOST_PATH_FIELDS) {
    if (typeof view[field] === "string" && view[field]) view[field] = HIDDEN_HOST_PATH;
  }
  return view;
}
