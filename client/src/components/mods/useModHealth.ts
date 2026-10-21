import { useCallback, useEffect, useRef, useState } from 'react'
import { modsApi, type ModHealth, type ModHealthFix, type ModHealthFixResult, type ModHealthIssue } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'

export interface ModHealthStore {
  health: ModHealth | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  error: unknown
  reload: () => Promise<void>
  /** POST /mods/health/fix; sets `health` from the response; rejects with the ApiError. */
  applyFix: (issue: ModHealthIssue, fix: ModHealthFix) => Promise<ModHealthFixResult>
}

/**
 * The active server's mod health check (GET /mods/health) and its one-click
 * fixes. `enabled` false sends nothing; a new `refreshKey` (the saved Mods=
 * line) checks again. A response that an older request returns after a newer
 * one started is dropped, and a fix's answer (it carries the health after the
 * write) replaces whatever a check still in flight would have said.
 */
export function useModHealth({ enabled, refreshKey }: { enabled: boolean; refreshKey?: string }): ModHealthStore {
  const [health, setHealth] = useState<ModHealth | null>(null)
  const [loadState, setLoadState] = useState<ModHealthStore['loadState']>('idle')
  const [error, setError] = useState<unknown>(null)
  const seqRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const reload = useCallback(async () => {
    const seq = ++seqRef.current
    setLoadState('loading')
    try {
      const data = await modsApi.getModHealth()
      if (!aliveRef.current || seq !== seqRef.current) return
      setHealth(data && Array.isArray(data.issues) ? data : null)
      setError(null)
      setLoadState('ready')
    } catch (err) {
      if (!aliveRef.current || seq !== seqRef.current) return
      reportClientWarning('Failed to check the mod list health.', err)
      setError(err)
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    if (enabled) void reload()
  }, [enabled, refreshKey, reload])

  const applyFix = useCallback(async (issue: ModHealthIssue, fix: ModHealthFix) => {
    const result = await modsApi.applyModHealthFix(issue.id, fix.action, fix.params)
    if (aliveRef.current && result?.health && Array.isArray(result.health.issues)) {
      // Newer than any check still out: that one must not overwrite it.
      seqRef.current++
      setHealth(result.health)
      setError(null)
      setLoadState('ready')
    }
    return result
  }, [])

  return { health, loadState, error, reload, applyFix }
}
