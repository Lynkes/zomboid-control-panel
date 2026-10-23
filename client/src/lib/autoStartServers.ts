// Client half of server/index.js's selectAutoStartServers(): which servers
// the panel starts when it starts. autoStartServer is the switch and
// autoStartServerIds names the servers. A setting saved before servers could
// be chosen has no list and means the active server, as it did then -- read
// the same way here, so the Dashboard and Settings show what the boot will do.

export type AutoStartSettings = {
  autoStartServer?: unknown;
  autoStartServerIds?: unknown;
};

export function autoStartEnabled(settings: AutoStartSettings | null | undefined): boolean {
  return settings?.autoStartServer === true || settings?.autoStartServer === "true";
}

// The chosen servers' ids, as strings. Without a list: the active server
// while the switch is on, none while it is off.
export function autoStartServerIds(
  settings: AutoStartSettings | null | undefined,
  activeServerId: string | number | null | undefined,
): string[] {
  if (Array.isArray(settings?.autoStartServerIds)) {
    return settings.autoStartServerIds.map((id) => String(id));
  }
  return autoStartEnabled(settings) && activeServerId !== null && activeServerId !== undefined
    ? [String(activeServerId)]
    : [];
}

// The list with one server added at the end, or taken out.
export function withAutoStartServer(ids: string[], serverId: string | number, chosen: boolean): string[] {
  const id = String(serverId);
  if (!chosen) return ids.filter((existing) => existing !== id);
  return ids.includes(id) ? ids : [...ids, id];
}
