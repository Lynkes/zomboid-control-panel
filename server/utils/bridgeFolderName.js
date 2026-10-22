// The folder the PanelBridge Lua mod keeps its files in, under
// <data folder>/Lua/panelbridge/, is not the server's name as it is written in
// the profile: PanelBridge.lua (getBasePath()) replaces every character that
// can't be in a file name -- / \ : * ? " < > | -- with "_" and then each run of
// whitespace with a single "_". A server called
// "AU-NZ AucklandApocalypse B42 - PvE" therefore writes to
// panelbridge/AU-NZ_AucklandApocalypse_B42_-_PvE/, and a lookup by the name as
// typed finds nothing.
//
// Every place that builds that path from a server name goes through here, so
// the panel and the mod cannot disagree. Keep it identical to the Lua:
//   safe = tostring(serverName)
//   safe = safe:gsub("[/\\:%*%?\"<>|]", "_")
//   safe = safe:gsub("%s+", "_")
// The game's Lua (Kahlua) matches %s against ASCII whitespace only (9-13 and
// 32; checked against StringLib.isSpace in projectzomboid.jar), not the wider
// set JavaScript's \s covers, so the pattern below spells the set out.
//
// "" for a missing or empty name: the mod then writes straight into
// panelbridge/ with no per-server folder, and path.join(..., "panelbridge", "")
// is that folder.
export function bridgeFolderName(serverName) {
  if (serverName === undefined || serverName === null) return "";
  const name = String(serverName);
  if (name === "") return "";
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/[ \t\n\v\f\r]+/g, "_");
}
