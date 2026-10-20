// Secrets the game itself writes to its console log (server-console.txt).
//
// SECURITY (2026-10-20): on a world's first start the game creates the
// "admin" account from the -adminpassword the panel passes it
// (routes/server.js) and logs the value in plain text, from
// zombie.network.ServerWorldDatabase:
//   LOG  : General      f:0 st:...> Command line admin password: <password>
// The support bundle copied that line as written, and the Console page
// showed it to every role with server.world_events (moderators included).
// No one needs to read it there, so it is redacted for every role.
// The panel refuses an admin password with a control character
// (services/startScriptValues.js), so the value never runs past the line.
const COMMAND_LINE_ADMIN_PASSWORD = /(Command line admin password:)[^\r\n]*/gi;

export function redactGameLogSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(COMMAND_LINE_ADMIN_PASSWORD, "$1 [REDACTED]");
}
