import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ROUTES } from '@/lib/navigation'
import { useGuardedNavigate } from '@/contexts/UnsavedChangesContext'

export interface ShortcutDef {
  key: string
  label: string
  path?: string
  action?: () => void
  group: string
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere: how the palette and Save shortcuts are written. */
export function modKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl'
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || navigator.userAgent
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl'
}

function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

// A Radix Dialog/AlertDialog (e.g. Dashboard's Force-Stop/Wipe-Server
// confirmations) traps Tab-cycling inside itself but does not stop other
// keys from bubbling up to these window-level listeners, and moves focus
// onto a non-input element inside the dialog (its content pane or a
// button) -- so isInputFocused() alone never sees it open. Without this,
// pressing a digit navigates the whole app away from under an open
// destructive-action confirmation instead of the keystroke reaching the
// dialog.
function isDialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

/**
 * The shell's keyboard: digits 1-9 open the registry's pages (asking first
 * when the page has unsaved edits), `?` toggles the shortcut list, and
 * Ctrl/Cmd+K toggles the command palette -- even from inside a field, but
 * never over another open dialog.
 */
export function useKeyboardShortcuts() {
  const guardedNavigate = useGuardedNavigate()
  const { t } = useTranslation('keyboardShortcuts')
  const [helpOpen, setHelpOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteOpenRef = useRef(paletteOpen)
  useEffect(() => {
    paletteOpenRef.current = paletteOpen
  }, [paletteOpen])

  const navShortcuts = useMemo<ShortcutDef[]>(() => {
    const group = t('groups.navigation')
    return ROUTES.filter((route) => route.shortcut)
      .sort((a, b) => Number(a.shortcut) - Number(b.shortcut))
      .map((route) => ({ key: route.shortcut as string, label: t(route.labelKey), path: route.path, group }))
  }, [t])

  const allShortcuts = useMemo<ShortcutDef[]>(() => {
    const mod = modKeyLabel()
    return [
      ...navShortcuts,
      { key: `${mod}+S`, label: t('page.save'), group: t('groups.pageActions') },
      { key: '/', label: t('page.focusSearch'), group: t('groups.pageActions') },
      { key: 'R', label: t('page.refreshDashboard'), group: t('groups.pageActions') },
      { key: '`', label: t('page.switchConsoleTab'), group: t('groups.pageActions') },
      { key: 'A', label: t('page.toggleAutoScroll'), group: t('groups.pageActions') },
      { key: `${mod}+K`, label: t('openPalette'), action: () => setPaletteOpen(true), group: t('groups.general') },
      { key: '?', label: t('showShortcuts'), action: () => setHelpOpen(true), group: t('groups.general') },
    ]
  }, [navShortcuts, t])

  // Capture phase, so the palette wins over a page's own Ctrl+K handler.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'k') return
      if (!paletteOpenRef.current && isDialogOpen()) return
      e.preventDefault()
      setPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't intercept when typing in inputs, or while a modal dialog owns
    // focus (see isDialogOpen's own comment).
    if (isInputFocused() || isDialogOpen()) return
    // Don't intercept modified keys (except Shift for ?)
    if (e.ctrlKey || e.altKey || e.metaKey) return

    const key = e.key

    if (key === '?') {
      e.preventDefault()
      setHelpOpen(prev => !prev)
      return
    }

    if (key === 'Escape') {
      setHelpOpen(false)
      return
    }

    const shortcut = navShortcuts.find(s => s.key === key)
    if (shortcut?.path) {
      e.preventDefault()
      void guardedNavigate(shortcut.path)
    }
  }, [guardedNavigate, navShortcuts])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return { helpOpen, setHelpOpen, paletteOpen, setPaletteOpen, shortcuts: allShortcuts }
}

/**
 * Register a page-specific keyboard shortcut. Active only while the component is mounted.
 * For Ctrl/Cmd shortcuts, set ctrl: true — these work even when an input is focused.
 * For unmodified keys, they are ignored when an input is focused.
 * Either way, both are suppressed while a modal dialog is open (see isDialogOpen).
 */
export function usePageShortcut(
  key: string,
  handler: () => void,
  options: { ctrl?: boolean } = {}
) {
  const stableHandler = useCallback(handler, [handler])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const wantsCtrl = options.ctrl ?? false
      const hasCtrl = e.ctrlKey || e.metaKey

      if (wantsCtrl && !hasCtrl) return
      if (!wantsCtrl && hasCtrl) return
      if (!wantsCtrl && isInputFocused()) return
      // A modal dialog (e.g. Dashboard's Force-Stop/Wipe-Server confirm)
      // owns the keyboard regardless of ctrl -- see isDialogOpen's comment.
      if (isDialogOpen()) return
      if (e.altKey) return
      if (e.key.toLowerCase() !== key.toLowerCase()) return

      e.preventDefault()
      stableHandler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [key, stableHandler, options.ctrl])
}
