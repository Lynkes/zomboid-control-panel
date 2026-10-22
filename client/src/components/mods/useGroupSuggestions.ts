import { useCallback, useEffect, useRef, useState } from 'react'
import { modsApi, type ModGroupSuggestion } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'

/**
 * The groups the server suggests for the active server's mods (empty while
 * none, or when unavailable). Read again when `refreshKey` changes: the
 * active server switched or its mod list changed.
 */
export function useGroupSuggestions(enabled: boolean, refreshKey = '') {
  const [suggestions, setSuggestions] = useState<ModGroupSuggestion[]>([])
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    try {
      const data = await modsApi.getGroupSuggestions()
      if (mine !== seq.current) return
      setSuggestions(Array.isArray(data?.suggestions) ? data.suggestions.filter((s) => Array.isArray(s?.modIds) && s.modIds.length > 0) : [])
    } catch (error) {
      if (mine !== seq.current) return
      // An older server has no suggestions route: the area just stays hidden.
      reportClientWarning('Failed to load mod group suggestions.', error)
      setSuggestions([])
    }
  }, [])

  useEffect(() => {
    if (enabled) void reload()
    else setSuggestions([])
  }, [enabled, reload, refreshKey])

  /** Hides it for every admin; rejects with the server's error (the caller reloads). */
  const dismiss = useCallback(async (key: string) => {
    setSuggestions((current) => current.filter((s) => s.key !== key))
    await modsApi.dismissGroupSuggestion(key)
  }, [])

  return { suggestions, reload, dismiss }
}
