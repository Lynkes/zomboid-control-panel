import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRequestGuard } from '@/hooks/useRequestGuard'
import { useSocket } from '@/contexts/SocketContext'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { reportClientError } from '@/lib/client-errors'
import { BASE_CHARACTER_SECTIONS, getCharacterSheet, type CharacterSheetResponse } from '@/lib/characterApi'

// Polls the selected player's character sheet for the Players page. Lifted
// into the page (not the tab) so the dossier's "Worth a look" badge is right
// whichever tab is open:
// - one base read (everything but the inventory) when a player is selected;
// - then a poll every refreshAfterMs, only while the player is online, the
//   Character tab is the active tab and the browser tab is visible;
// - the inventory only once someone asks for it, and polled only while it's
//   on screen;
// - Refresh bypasses the bridge's short cache (fresh=1);
// - a player going offline stops the poll and flips the sheet to last known;
// - a server switch drops everything and starts over.

const DEFAULT_REFRESH_MS = 10000
const DEFAULT_INVENTORY_REFRESH_MS = 30000

export interface UseCharacterSheetOptions {
  username: string
  online: boolean
  /** The Character tab is the active tab. */
  active: boolean
}

export interface CharacterSheetState {
  base: CharacterSheetResponse | null
  baseLoading: boolean
  baseError: string | null
  inventory: CharacterSheetResponse | null
  inventoryRequested: boolean
  inventoryLoading: boolean
  inventoryError: string | null
  loadInventory: () => void
  setInventoryVisible: (visible: boolean) => void
  refresh: () => void
  retry: () => void
}

function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

export function useCharacterSheet({ username, online, active }: UseCharacterSheetOptions): CharacterSheetState {
  const { t } = useTranslation('players')
  const socket = useSocket()
  const baseGuard = useRequestGuard()
  const inventoryGuard = useRequestGuard()

  const [base, setBase] = useState<CharacterSheetResponse | null>(null)
  const [baseLoading, setBaseLoading] = useState(false)
  const [baseError, setBaseError] = useState<string | null>(null)
  const [inventory, setInventory] = useState<CharacterSheetResponse | null>(null)
  const [inventoryRequested, setInventoryRequested] = useState(false)
  const [inventoryVisible, setInventoryVisible] = useState(false)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const [pageVisible, setPageVisible] = useState(isPageVisible)
  const lastBaseAtRef = useRef(0)
  const lastInventoryAtRef = useRef(0)

  const fetchBase = useCallback(
    async (opts: { fresh?: boolean } = {}) => {
      if (!username) return
      const requestId = baseGuard.next()
      setBaseLoading(true)
      try {
        const response = await getCharacterSheet(username, { sections: BASE_CHARACTER_SECTIONS, fresh: opts.fresh })
        if (baseGuard.isStale(requestId)) return
        lastBaseAtRef.current = Date.now()
        setBase(response)
        setBaseError(null)
      } catch (error) {
        if (baseGuard.isStale(requestId)) return
        reportClientError('Failed to load the character sheet.', error)
        setBaseError(getUserErrorMessage(error, t('character.state.loadError')))
      } finally {
        if (!baseGuard.isStale(requestId)) setBaseLoading(false)
      }
    },
    [username, baseGuard, t],
  )

  const fetchInventory = useCallback(
    async (opts: { fresh?: boolean } = {}) => {
      if (!username) return
      const requestId = inventoryGuard.next()
      setInventoryLoading(true)
      try {
        const response = await getCharacterSheet(username, { sections: ['inventory'], fresh: opts.fresh })
        if (inventoryGuard.isStale(requestId)) return
        lastInventoryAtRef.current = Date.now()
        setInventory(response)
        setInventoryError(null)
      } catch (error) {
        if (inventoryGuard.isStale(requestId)) return
        reportClientError('Failed to load the character inventory.', error)
        setInventoryError(getUserErrorMessage(error, t('character.state.loadError')))
      } finally {
        if (!inventoryGuard.isStale(requestId)) setInventoryLoading(false)
      }
    },
    [username, inventoryGuard, t],
  )

  // A new player: forget the last one (and any answer still on its way for
  // it), then read the new one once, whatever tab is open.
  useEffect(() => {
    baseGuard.next()
    inventoryGuard.next()
    setBase(null)
    setBaseError(null)
    setBaseLoading(false)
    setInventory(null)
    setInventoryRequested(false)
    setInventoryError(null)
    setInventoryLoading(false)
    lastBaseAtRef.current = 0
    lastInventoryAtRef.current = 0
    if (username) void fetchBase()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new username starts over; fetchBase changes with it
  }, [username])

  // Online <-> offline for the same player: read once more, so the sheet
  // flips to last known (or back to live) without waiting for a poll that no
  // longer runs. A new selection already reads above.
  const previousOnlineRef = useRef({ username, online })
  useEffect(() => {
    const previous = previousOnlineRef.current
    previousOnlineRef.current = { username, online }
    if (previous.username !== username || previous.online === online) return
    if (username) void fetchBase()
  }, [online, username, fetchBase])

  useEffect(() => {
    const onVisibility = () => setPageVisible(isPageVisible())
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const refreshAfterMs = base?.refreshAfterMs ?? DEFAULT_REFRESH_MS
  const inventoryRefreshAfterMs = base?.inventoryRefreshAfterMs ?? inventory?.inventoryRefreshAfterMs ?? DEFAULT_INVENTORY_REFRESH_MS

  // Base poll. Coming back to the tab (or the browser tab) reads right away
  // when the last read is older than one interval.
  useEffect(() => {
    if (!username || !online || !active || !pageVisible) return
    if (lastBaseAtRef.current > 0 && Date.now() - lastBaseAtRef.current >= refreshAfterMs) void fetchBase()
    const id = setInterval(() => {
      if (!isPageVisible()) return
      void fetchBase()
    }, refreshAfterMs)
    return () => clearInterval(id)
  }, [username, online, active, pageVisible, refreshAfterMs, fetchBase])

  // Inventory poll: only once requested, and only while it's on screen.
  useEffect(() => {
    if (!username || !online || !active || !pageVisible || !inventoryRequested || !inventoryVisible) return
    if (lastInventoryAtRef.current > 0 && Date.now() - lastInventoryAtRef.current >= inventoryRefreshAfterMs) {
      void fetchInventory()
    }
    const id = setInterval(() => {
      if (!isPageVisible()) return
      void fetchInventory()
    }, inventoryRefreshAfterMs)
    return () => clearInterval(id)
  }, [username, online, active, pageVisible, inventoryRequested, inventoryVisible, inventoryRefreshAfterMs, fetchInventory])

  // Another server's player of the same name is a different character.
  useEffect(() => {
    if (!socket) return
    const onActiveServerChanged = () => {
      baseGuard.next()
      inventoryGuard.next()
      setBase(null)
      setInventory(null)
      setBaseError(null)
      setInventoryError(null)
      lastBaseAtRef.current = 0
      lastInventoryAtRef.current = 0
      if (!username) return
      void fetchBase()
      if (inventoryRequested) void fetchInventory()
    }
    socket.on('activeServerChanged', onActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', onActiveServerChanged)
    }
  }, [socket, username, inventoryRequested, baseGuard, inventoryGuard, fetchBase, fetchInventory])

  const loadInventory = useCallback(() => {
    setInventoryRequested(true)
    void fetchInventory()
  }, [fetchInventory])

  const refresh = useCallback(() => {
    void fetchBase({ fresh: true })
    if (inventoryRequested) void fetchInventory({ fresh: true })
  }, [fetchBase, fetchInventory, inventoryRequested])

  const retry = useCallback(() => {
    void fetchBase()
  }, [fetchBase])

  return {
    base,
    baseLoading,
    baseError,
    inventory,
    inventoryRequested,
    inventoryLoading,
    inventoryError,
    loadInventory,
    setInventoryVisible,
    refresh,
    retry,
  }
}
