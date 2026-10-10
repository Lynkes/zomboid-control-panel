// PUT /api/config/app-settings answers { success: true, warnings?: string[] }
// when the settings were saved but the panel could not apply some of them
// live (the server manager, the RCON service or the CORS rules failed to
// reload). The warnings are plain server-side English with no codes, so they
// are shown as the server wrote them.
export function extractSaveWarnings(result: unknown): string[] {
  const warnings = (result as { warnings?: unknown } | null | undefined)?.warnings
  if (!Array.isArray(warnings)) return []
  return warnings
    .filter((warning): warning is string => typeof warning === 'string')
    .map((warning) => warning.trim())
    .filter(Boolean)
}
