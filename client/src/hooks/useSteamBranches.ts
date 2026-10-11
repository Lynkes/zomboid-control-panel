import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import { serverApi } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'

// How long the SteamCMD path field has to sit still before the branch list is
// looked up again. Every lookup runs SteamCMD (+app_info_update), so one per
// keystroke is far too many.
export const STEAMCMD_PATH_DEBOUNCE_MS = 600

export interface SteamBranchOption {
  name: string
  description: string
  buildId?: string | null
  timeUpdated?: string | null
}

// The part of the Update / Verify dialog state this hook reads and reconciles.
export interface SteamBranchOperation {
  server: { id: string | number; branch?: string | null }
  branch: string
}

interface UseSteamBranchesOptions<Op extends SteamBranchOperation> {
  operation: Op | null
  setOperation: Dispatch<SetStateAction<Op | null>>
  steamcmdPath: string
  setSteamcmdPath: Dispatch<SetStateAction<string>>
  // The branch the install on disk was built from (the update check's answer).
  installedBranch: string | null | undefined
  t: TFunction
}

const normalize = (value: string | undefined | null) => (value || '').trim().toLowerCase()

// Fetches the Steam branches for the Update / Verify dialog.
//
// The lookup is keyed on WHICH SERVER the dialog is for, not on the dialog
// state object: picking a branch replaces that object and used to re-run the
// whole lookup (another SteamCMD spawn) for nothing. Edits to the SteamCMD path
// are waited out (STEAMCMD_PATH_DEBOUNCE_MS), and a lookup that would ask the
// same SteamCMD folder the same question as the last one is skipped.
export function useSteamBranches<Op extends SteamBranchOperation>({
  operation,
  setOperation,
  steamcmdPath,
  setSteamcmdPath,
  installedBranch,
  t,
}: UseSteamBranchesOptions<Op>) {
  const [availableBranches, setAvailableBranches] = useState<SteamBranchOption[]>([
    { name: 'public', description: t('branches.public') },
    { name: 'unstable', description: t('branches.unstable') },
  ])
  const [loadingBranches, setLoadingBranches] = useState(false)

  // Generation counter: a slower response from an earlier lookup must not land
  // after a newer one and overwrite the branch list / selected branch.
  const fetchIdRef = useRef(0)
  const lastLookupRef = useRef<{ serverId: string | number; path: string; installedBranch: string } | null>(null)
  const operationRef = useRef(operation)
  useEffect(() => {
    operationRef.current = operation
  })

  const serverId = operation?.server.id ?? null

  useEffect(() => {
    if (serverId === null) {
      lastLookupRef.current = null
      return
    }

    const installed = normalize(installedBranch)
    // The first lookup for a dialog goes out at once; later ones (the path
    // field changed) wait for the typing to stop.
    const delay = lastLookupRef.current?.serverId === serverId ? STEAMCMD_PATH_DEBOUNCE_MS : 0
    let cancelled = false

    const fetchBranches = async () => {
      let thisFetchId: number | null = null
      try {
        const detection = await serverApi.detectSteamCmd()
        if (cancelled) return
        const resolvedSteamcmdPath = detection.found && detection.path ? detection.path : steamcmdPath
        if (resolvedSteamcmdPath) {
          // Detection is asynchronous. Do not replace a path the operator
          // typed after the dialog opened but before detection completed.
          setSteamcmdPath((currentPath) => currentPath.trim() || resolvedSteamcmdPath)
        }

        const last = lastLookupRef.current
        if (
          last &&
          last.serverId === serverId &&
          last.path === resolvedSteamcmdPath &&
          last.installedBranch === installed
        ) {
          return
        }
        lastLookupRef.current = { serverId, path: resolvedSteamcmdPath, installedBranch: installed }

        thisFetchId = ++fetchIdRef.current
        setLoadingBranches(true)
        const data = await serverApi.getBranches(resolvedSteamcmdPath)
        if (thisFetchId !== fetchIdRef.current) return
        if (data.branches && Array.isArray(data.branches)) {
          setAvailableBranches(() => {
            const fetched = data.branches as SteamBranchOption[]
            // SteamCMD's anonymous branch listing usually only returns `public`.
            // Make sure the installed branch, the server's branch, and the currently
            // selected branch all remain pickable so we never silently drop the user's choice.
            const extras: SteamBranchOption[] = []
            const have = new Set(fetched.map((b) => b.name))
            const current = operationRef.current
            const candidates = [
              installed,
              normalize(current?.server.branch),
              normalize(current?.branch),
            ].filter(Boolean)
            for (const name of candidates) {
              if (!have.has(name)) {
                const description = name === 'unstable'
                  ? t('branches.unstableDesc')
                  : name === 'iwbums'
                    ? t('branches.iwbumsDesc')
                    : t('branches.genericBetaDesc')
                extras.push({ name, description })
                have.add(name)
              }
            }
            return [...fetched, ...extras]
          })
          // Only reconcile the selected branch if it's truly unknown and not the
          // installed/server branch. Never override what the server is actually running.
          setOperation((prev) => {
            if (!prev) return prev
            const names = new Set(data.branches.map((b: { name: string }) => b.name))
            const serverBranch = normalize(prev.server.branch)
            if (prev.branch === installed) return prev
            if (prev.branch === serverBranch) return prev
            if (names.has(prev.branch)) return prev
            const fallback = installed || serverBranch || (names.has('public') ? 'public' : data.branches[0]?.name)
            return fallback ? { ...prev, branch: fallback } : prev
          })
        }
      } catch (error) {
        // Let the next trigger try again instead of treating this as answered.
        lastLookupRef.current = null
        reportClientError('Failed to fetch branches.', error)
        // Keep default branches on error
      } finally {
        if (thisFetchId !== null && thisFetchId === fetchIdRef.current) setLoadingBranches(false)
      }
    }

    const timer = setTimeout(fetchBranches, delay)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [serverId, steamcmdPath, installedBranch, setOperation, setSteamcmdPath, t])

  return { availableBranches, loadingBranches }
}
