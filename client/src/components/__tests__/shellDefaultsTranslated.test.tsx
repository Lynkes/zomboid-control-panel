import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import i18n from '@/i18n'
import { LANGUAGES } from '@/i18n/languages'
import { ConfirmProvider, useConfirm } from '@/contexts/ConfirmContext'
import { PageSkeleton } from '../PageSkeleton'
import { BuildCompatibilityGate } from '../BuildCompatibilityGate'
import { compiledBuildMetadata } from '@/lib/buildCompatibility'
import frShell from '../../locales/fr/shell.json'
import deShell from '../../locales/de/shell.json'

// Texts a component falls back to when its caller gives none: the confirm
// dialog's title and buttons, the page skeleton's header and labels, and the
// "frontend and backend do not match" screen. They were English literals.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  void i18n.changeLanguage('en')
})

function Ask() {
  const confirm = useConfirm()
  useEffect(() => { void confirm({ description: 'Remove it.' }) }, [confirm])
  return null
}

describe('ConfirmProvider: defaults', () => {
  it('keeps the English wording for English', async () => {
    render(<ConfirmProvider><Ask /></ConfirmProvider>)
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Are you sure?')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
  })

  it('translates the title and both buttons when the caller sets none', async () => {
    void i18n.changeLanguage('fr')
    render(<ConfirmProvider><Ask /></ConfirmProvider>)
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(frShell.confirmDialog.defaultTitle)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: frShell.confirmDialog.cancel })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: frShell.confirmDialog.confirm })).toBeInTheDocument()
  })
})

describe('PageSkeleton: defaults', () => {
  it('shows the stock header and labels in English', () => {
    render(<PageSkeleton />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading page')
    const heading = document.querySelector('h1')!
    expect(heading).toHaveTextContent('Loading page')
    expect(document.body).toHaveTextContent('Preparing panel data and controls.')
    expect(document.body).toHaveTextContent('// PANEL · LOADING')
  })

  it('translates the header, the metric chips and the label of every layout', () => {
    void i18n.changeLanguage('de')
    const labels = deShell.pageSkeleton.labels
    const expected = {
      dashboard: labels.dashboard,
      list: labels.list,
      console: labels.console,
      form: labels.form,
      map: labels.map,
      default: labels.page,
    } as const
    for (const [variant, label] of Object.entries(expected)) {
      const { unmount } = render(<PageSkeleton variant={variant as keyof typeof expected} />)
      expect(screen.getByRole('status')).toHaveAttribute('aria-label', label)
      expect(document.body).toHaveTextContent(deShell.pageSkeleton.defaultTitle)
      expect(document.body).toHaveTextContent(deShell.pageSkeleton.defaultDescription)
      expect(document.body).toHaveTextContent(deShell.pageSkeleton.defaultEyebrow)
      expect(document.body).toHaveTextContent(deShell.pageSkeleton.metrics.socket)
      unmount()
    }
  })

  it('wraps a title the caller gave in the translated "Loading {{title}}" label', () => {
    void i18n.changeLanguage('fr')
    render(<PageSkeleton variant="list" title="Sauvegardes" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Chargement : Sauvegardes')
  })

  it.each(LANGUAGES.map((l) => l.code).filter((code) => code !== 'en'))('%s has no English left in the stock header', (lang) => {
    void i18n.changeLanguage(lang)
    render(<PageSkeleton variant="form" />)
    expect(screen.getByRole('status')).not.toHaveAttribute('aria-label', 'Loading form page')
    expect(document.body).not.toHaveTextContent('Preparing panel data and controls.')
  })
})

describe('BuildCompatibilityGate: version mismatch screen', () => {
  async function renderMismatch() {
    const frontend = compiledBuildMetadata()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status: 'ok', panelVersion: '0.0.1-other', version: '0.0.1-other', buildSha: 'othersha00000000', apiContractVersion: frontend.apiContractVersion }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    render(<BuildCompatibilityGate><p>the app</p></BuildCompatibilityGate>)
    return screen.findByRole('heading', { level: 1 })
  }

  it('reads in English by default', async () => {
    const heading = await renderMismatch()
    expect(heading).toHaveTextContent('Frontend and backend versions do not match')
    expect(screen.getByText('Update recovery required')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(screen.getByText('Frontend')).toBeInTheDocument()
    expect(screen.getByText('Backend')).toBeInTheDocument()
  })

  it('is translated: eyebrow, title, explanation, labels and button', async () => {
    void i18n.changeLanguage('de')
    const heading = await renderMismatch()
    expect(heading).toHaveTextContent(deShell.buildGate.title)
    expect(screen.getByText(deShell.buildGate.eyebrow)).toBeInTheDocument()
    expect(screen.getByText(deShell.buildGate.description)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: deShell.buildGate.checkAgain })).toBeInTheDocument()
    expect(screen.queryByText('Update recovery required')).not.toBeInTheDocument()
  })

  it('names the compatibility check for assistive tech in the active language while it runs', () => {
    void i18n.changeLanguage('fr')
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<BuildCompatibilityGate><p>the app</p></BuildCompatibilityGate>)
    expect(screen.getByRole('main')).toHaveAttribute('aria-label', frShell.buildGate.checking)
  })
})
