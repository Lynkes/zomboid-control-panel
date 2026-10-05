import { getRoleByName } from "../services/permissions.js";

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
export async function canSeeHostPaths(user) {
  if (!user) return false;
  try {
    const role = await getRoleByName(user.role);
    const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
    return HOST_PATH_CAPABILITIES.some((capability) => capabilities.includes(capability));
  } catch {
    return false;
  }
}

export function hideHostPaths(record) {
  if (!record || typeof record !== "object") return record;
  const view = { ...record };
  for (const field of HOST_PATH_FIELDS) {
    if (typeof view[field] === "string" && view[field]) view[field] = HIDDEN_HOST_PATH;
  }
  return view;
}
