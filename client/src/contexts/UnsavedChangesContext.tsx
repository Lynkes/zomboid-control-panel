import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, type NavigateOptions, type To } from 'react-router-dom'
import { useConfirm } from '@/contexts/ConfirmContext'

// The panel runs under BrowserRouter (HashRouter in demo mode), which has no
// useBlocker. So the guard works at the two places navigation starts:
//   - every in-app <a> click (sidebar rows, page links, badges): a capture
//     listener on the document stops it, asks, then replays the same click;
//   - programmatic moves (palette, keyboard shortcuts) go through
//     useGuardedNavigate().
// Only a move to another page asks: changing ?tab= on the same page keeps
// the form mounted, so nothing is lost. Reload and tab close get the
// browser's own beforeunload prompt from useUnsavedChangesGuard itself.

interface GuardEntry {
  dirty: boolean
  message?: string
}

interface UnsavedChangesContextValue {
  register: (id: string, entry: GuardEntry) => void
  unregister: (id: string) => void
  /** True when no guard is dirty, or the operator chose to leave anyway. */
  confirmLeave: () => Promise<boolean>
  isDirty: () => boolean
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null)

function pathOf(to: To): string {
  if (typeof to === 'string') return to.split(/[?#]/)[0]
  return to.pathname ?? ''
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('shell')
  const confirm = useConfirm()
  const entries = useRef(new Map<string, GuardEntry>())
  const location = useLocation()
  const pathnameRef = useRef(location.pathname)
  useEffect(() => {
    pathnameRef.current = location.pathname
  }, [location.pathname])
  const bypass = useRef(false)
  const asking = useRef(false)

  const isDirty = useCallback(() => [...entries.current.values()].some((entry) => entry.dirty), [])

  const confirmLeave = useCallback(async () => {
    const dirty = [...entries.current.values()].filter((entry) => entry.dirty)
    if (dirty.length === 0) return true
    if (asking.current) return false
    asking.current = true
    try {
      return await confirm({
        title: t('unsavedChanges.title'),
        description: dirty.find((entry) => entry.message)?.message ?? t('unsavedChanges.description'),
        confirmLabel: t('unsavedChanges.leave'),
        cancelLabel: t('unsavedChanges.stay'),
        destructive: true,
      })
    } finally {
      asking.current = false
    }
  }, [confirm, t])

  const value = useMemo<UnsavedChangesContextValue>(() => ({
    register: (id, entry) => { entries.current.set(id, entry) },
    unregister: (id) => { entries.current.delete(id) },
    confirmLeave,
    isDirty,
  }), [confirmLeave, isDirty])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (bypass.current || event.defaultPrevented) return
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download') || anchor.dataset.unsavedGuard === 'off') return
      const href = anchor.getAttribute('href') ?? ''
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      // HashRouter (demo mode) keeps the route in the hash ("#/players").
      // Any other fragment ("#main-content", the skip link) is a jump
      // within the page, not another page.
      if (href.startsWith('#') && !href.startsWith('#/')) return
      const targetPath = href.startsWith('#') ? pathOf(href.slice(1)) : url.pathname
      if (!targetPath || targetPath === pathnameRef.current) return
      if (!isDirty()) return

      event.preventDefault()
      void confirmLeave().then((leave) => {
        if (!leave || !anchor.isConnected) return
        // Replay the click so the link navigates exactly as it would have
        // (NavLink side effects, replace, state), this time unguarded.
        bypass.current = true
        try {
          anchor.click()
        } finally {
          bypass.current = false
        }
      })
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [confirmLeave, isDirty])

  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>
}

/**
 * Marks this page as holding unsaved edits while `dirty` is true: leaving
 * through the sidebar, a link, the command palette or a shortcut asks
 * first, and closing or reloading the tab gets the browser's prompt. Works
 * without the provider too (the beforeunload part only), so a page renders
 * the same in tests.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useUnsavedChangesGuard(dirty: boolean, opts?: { message?: string }): void {
  const context = useContext(UnsavedChangesContext)
  const id = useId()
  const message = opts?.message

  useEffect(() => {
    if (!context) return
    context.register(id, { dirty, message })
  }, [context, id, dirty, message])

  useEffect(() => {
    if (!context) return
    return () => context.unregister(id)
  }, [context, id])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers still want returnValue set to show the prompt.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}

/**
 * navigate() that asks before leaving a page with unsaved edits. Resolves
 * to whether it navigated.
 */
// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useGuardedNavigate(): (to: To, options?: NavigateOptions) => Promise<boolean> {
  const context = useContext(UnsavedChangesContext)
  const navigate = useNavigate()
  const location = useLocation()
  const pathname = location.pathname

  return useCallback(async (to: To, options?: NavigateOptions) => {
    const targetPath = pathOf(to)
    const samePage = targetPath === '' || targetPath === pathname
    if (context && !samePage && !(await context.confirmLeave())) return false
    navigate(to, options)
    return true
  }, [context, navigate, pathname])
}

/** Asks before an action that would drop unsaved edits without navigating. */
// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useConfirmLeave(): () => Promise<boolean> {
  const context = useContext(UnsavedChangesContext)
  return useCallback(async () => (context ? context.confirmLeave() : true), [context])
}
