import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { PageSkeleton, RoutePageSkeleton } from '../PageSkeleton'
import enServerconfig from '../../locales/en/serverconfig.json'
import deServerconfig from '../../locales/de/serverconfig.json'
import deShell from '../../locales/de/shell.json'

afterEach(() => {
  cleanup()
  void i18n.changeLanguage('en')
})

describe('PageSkeleton', () => {
  it('announces itself as busy/loading for assistive tech, for every variant', () => {
    const variants = ['dashboard', 'list', 'form', 'console', 'map', 'default'] as const
    for (const variant of variants) {
      const { unmount } = render(<PageSkeleton variant={variant} />)
      const status = screen.getByRole('status')
      expect(status).toHaveAttribute('aria-busy', 'true')
      unmount()
    }
  })

  it('includes the real page title in the loading label when given, so it is not a generic "Loading page" for every screen', () => {
    render(<PageSkeleton variant="list" title="Backups" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading Backups')
  })

  it('falls back to a generic label when no title is given', () => {
    render(<PageSkeleton variant="form" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading form page')
  })

  it('renders a distinct structure for the dashboard variant vs. the console variant', () => {
    const { container: dash } = render(<PageSkeleton variant="dashboard" />)
    const { container: console_ } = render(<PageSkeleton variant="console" />)
    // Dashboard shows a 4-up stat grid; console does not.
    expect(dash.querySelectorAll('.grid.grid-cols-1.md\\:grid-cols-2.lg\\:grid-cols-4').length).toBe(1)
    expect(console_.querySelectorAll('.grid.grid-cols-1.md\\:grid-cols-2.lg\\:grid-cols-4').length).toBe(0)
  })
})

// UX review D1: the loader used an English-only table whose titles differed
// from the page headers ("My Servers" flashing before "Managed Servers").
// It now shows the registry's title, which is the page header's own key.
describe('RoutePageSkeleton', () => {
  it('names the loading page with the same title and description its header will show', () => {
    render(<RoutePageSkeleton pathname="/server-config" />)
    expect(document.querySelector('h1')).toHaveTextContent(enServerconfig.pageHeader.title)
    expect(document.body).toHaveTextContent(enServerconfig.pageHeader.description)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', `Loading ${enServerconfig.pageHeader.title}`)
    expect(document.querySelector('.page-header-shell')).toHaveAttribute('data-tone', 'server')
  })

  it('is translated', () => {
    void i18n.changeLanguage('de')
    render(<RoutePageSkeleton pathname="/server-config" />)
    expect(document.querySelector('h1')).toHaveTextContent(deServerconfig.pageHeader.title)
    expect(document.body).toHaveTextContent(deServerconfig.pageHeader.description)
  })

  it('names the Dashboard from the shell when it has no header of its own', () => {
    void i18n.changeLanguage('de')
    render(<RoutePageSkeleton pathname="/" />)
    expect(document.querySelector('h1')).toHaveTextContent(deShell.nav.dashboard)
    expect(document.body).toHaveTextContent(deShell.routes.dashboardDescription)
  })

  it('falls back to the stock skeleton for an unknown path', () => {
    render(<RoutePageSkeleton pathname="/no-such-page" />)
    expect(document.querySelector('h1')).toHaveTextContent('Loading page')
  })
})
