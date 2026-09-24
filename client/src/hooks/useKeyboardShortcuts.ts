import { useEffect, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export interface ShortcutDef {
  key: string
  label: string
  path?: string
  action?: () => void
  group: string
}

type TFn = (key: string) => string

function buildNavShortcuts(t: TFn): ShortcutDef[] {
  const group = t('groups.navigation')
  return [
    { key: '1', label: t('nav.dashboard'), path: '/', group },
    { key: '2', label: t('nav.console'), path: '/console', group },
    { key: '3', label: t('nav.players'), path: '/players', group },
    { key: '4', label: t('nav.chat'), path: '/chat', group },
    { key: '5', label: t('nav.events'), path: '/events', group },
    { key: '6', label: t('nav.mods'), path: '/mods', group },
    { key: '7', label: t('nav.backups'), path: '/backups', group },
    { key: '8', label: t('nav.serverConfig'), path: '/server-config', group },
    { key: '9', label: t('nav.settings'), path: '/settings', group },
  ]
}

function buildPageShortcuts(t: TFn): ShortcutDef[] {
  const group = t('groups.pageActions')
  return [
    { key: 'Ctrl+S', label: t('page.save'), group },
    { key: 'Ctrl+K', label: t('page.focusSearch'), group },
    { key: 'R', label: t('page.refreshDashboard'), group },
    { key: '`', label: t('page.switchConsoleTab'), group },
    { key: 'A', label: t('page.toggleAutoScroll'), group },
  ]
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

export function useKeyboardShortcuts() {
  const navigate = useNavigate()
  const { t } = useTranslation('keyboardShortcuts')
  const [helpOpen, setHelpOpen] = useState(false)

  const navShortcuts = buildNavShortcuts(t)

  const allShortcuts: ShortcutDef[] = [
    ...navShortcuts,
    ...buildPageShortcuts(t),
    { key: '?', label: t('showShortcuts'), action: () => setHelpOpen(true), group: t('groups.general') },
  ]

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
      navigate(shortcut.path)
    }
  }, [navigate, navShortcuts])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return { helpOpen, setHelpOpen, shortcuts: allShortcuts }
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
