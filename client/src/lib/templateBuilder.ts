/**
 * Builds a simulation-template payload (server/utils/templateSchema.js shape)
 * from a server's current server.ini + SandboxVars.lua. This captures the
 * full current config rather than diffing against PZ's own defaults — doing
 * that diff would require duplicating the large default-value table from
 * serverConfigSchema.ts here, and would drift as that schema grows. Excluded
 * identity/secret keys mirror server/utils/templateSchema.js's
 * DEFAULT_INI_EXCLUSIONS (the backend independently enforces the same list),
 * and so does the secret-key pattern: TEMPLATE_SECRET_KEY_PATTERN is the
 * server's SENSITIVE_FIELD_RE (server/utils/sanitize.js). Keys compare
 * without case. Both are checked by serverClientConstantParity.test.js.
 */
export const TEMPLATE_INI_EXCLUSIONS = [
  "RCONPassword",
  "Password",
  "ServerName",
  "PublicName",
  "DefaultPort",
  "UDPPort",
  "RCONPort",
  "server_browser_announced_ip",
  "UPnP",
  "Mods",
  "WorkshopItems",
  "Map",
  "DoLuaChecksum",
  "DiscordToken",
];

export const TEMPLATE_SECRET_KEY_PATTERN = /password|secret|token|apikey|api_key|jwt|sessionid|loginsecure|cookie|webhook|recovery/i;

export function isTemplateIniKeyExcluded(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    TEMPLATE_SECRET_KEY_PATTERN.test(key) ||
    TEMPLATE_INI_EXCLUSIONS.some((excluded) => excluded.toLowerCase() === lower)
  );
}

export type SandboxSectionValues = Record<string, string | number | boolean>;

export interface CurrentSandboxConfig {
  settings: SandboxSectionValues;
  ZombieLore: SandboxSectionValues;
  ZombieConfig: SandboxSectionValues;
  MultiplierConfig: SandboxSectionValues;
  Map: SandboxSectionValues;
  Basement: SandboxSectionValues;
}

export interface TemplateCapture {
  serverIni: Record<string, string>;
  sandboxVars: Record<string, SandboxSectionValues>;
  iniKeyCount: number;
  sandboxKeyCount: number;
}

export function buildTemplateCapture(
  iniSettings: Record<string, string>,
  sandbox: CurrentSandboxConfig,
): TemplateCapture {
  const serverIni = Object.fromEntries(
    Object.entries(iniSettings || {}).filter(
      ([key]) => !isTemplateIniKeyExcluded(key),
    ),
  );
  const sandboxVars: Record<string, SandboxSectionValues> = {
    settings: sandbox.settings || {},
    ZombieLore: sandbox.ZombieLore || {},
    ZombieConfig: sandbox.ZombieConfig || {},
    MultiplierConfig: sandbox.MultiplierConfig || {},
    Map: sandbox.Map || {},
    Basement: sandbox.Basement || {},
  };
  const sandboxKeyCount = Object.values(sandboxVars).reduce(
    (n, section) => n + Object.keys(section).length,
    0,
  );
  return {
    serverIni,
    sandboxVars,
    iniKeyCount: Object.keys(serverIni).length,
    sandboxKeyCount,
  };
}
