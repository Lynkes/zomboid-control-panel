/**
 * Human-readable labels for simulation template diffs (server/routes/templates.js).
 * Prefers the descriptive labels already curated in serverConfigSchema.ts;
 * falls back to splitting the raw PZ key (e.g. "PVPMeleeDamageModifier")
 * into words for settings that schema doesn't (yet) describe.
 */
import { getIniSetting, getSandboxSetting } from "./serverConfigSchema";

const ACRONYM_LABELS: Record<string, string> = {
  pvp: "PVP",
};

/** Splits a PascalCase/camelCase PZ config key into spaced words. */
export function humanizeTemplateKey(key: string): string {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getIniKeyLabel(key: string): string {
  return getIniSetting(key)?.label || humanizeTemplateKey(key);
}

export function getSandboxKeyLabel(key: string): string {
  return getSandboxSetting(key)?.label || humanizeTemplateKey(key);
}

/** e.g. "hardcore" -> "Hardcore", "pvp" -> "PVP", "first-week" -> "First Week". */
export function formatDifficultyLabel(level: string | undefined): string {
  if (!level) return "Custom";
  return level
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => ACRONYM_LABELS[word.toLowerCase()] || word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Renders a diff value for display: booleans as On/Off, undefined as "(not set)". */
export function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "(not set)";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === "true" || value === "false") return value === "true" ? "On" : "Off";
  return String(value);
}
