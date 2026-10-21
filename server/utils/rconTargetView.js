import { getRoleByName } from "../services/permissions.js";

// SECURITY (2026-10-20, access-control audit): where RCON connects -- a
// server's RCON host and port -- goes only to the roles that work with that
// connection: servers.manage (edits it on the Servers page), rcon.execute
// (runs commands through it) and server.configure (governs it: PUT
// /api/servers/:id, /configure-rcon and the rconHost/rconPort app settings).
// Every read that carries it asks canSeeRconTarget() -- GET /api/rcon/status,
// GET /api/server/status, GET /api/server-status/active/status and GET
// /api/servers (/, /active, /:id) -- so the rule lives here once. GET
// /api/rcon/status alone hid them at first, while the other three still
// gave them to every signed-in role.
//
// For any other role the fields are left out, not masked: a page reads a
// missing host or port as hidden, not as "RCON isn't set up" (the masked
// rconPassword of a server record still says whether one is).
export const RCON_TARGET_CAPABILITIES = Object.freeze([
  "servers.manage",
  "rcon.execute",
  "server.configure",
]);

// Fails closed: a caller whose role can't be resolved doesn't see them.
export async function canSeeRconTarget(user) {
  if (!user) return false;
  try {
    const role = await getRoleByName(user.role);
    const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
    return RCON_TARGET_CAPABILITIES.some((capability) => capabilities.includes(capability));
  } catch {
    return false;
  }
}

/** A server record without its rconHost and rconPort. */
export function withoutRconTarget(server) {
  if (!server || typeof server !== "object") return server;
  const { rconHost: _rconHost, rconPort: _rconPort, ...rest } = server;
  return rest;
}

/** RconService.getConfig()'s answer without host and port. */
export function withoutRconConfigTarget(config) {
  if (!config || typeof config !== "object") return config;
  const { host: _host, port: _port, ...rest } = config;
  return rest;
}
