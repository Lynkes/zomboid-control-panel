import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { VerdictBand, WorkList, type Verdict, type WorkItem } from '../dashboard/DashboardVerdict'

function renderBand(props: Partial<Parameters<typeof VerdictBand>[0]> = {}) {
  const defaults: Parameters<typeof VerdictBand>[0] = {
    verdict: { level: 'calm' },
    players: [],
    showPresence: true,
    lastUpdated: new Date(),
    stale: false,
  }
  return render(
    <MemoryRouter>
      <VerdictBand {...defaults} {...props} />
    </MemoryRouter>
  )
}

describe('VerdictBand', () => {
  it('a critical verdict gets role="alert" -- screen readers must interrupt for it, not read it as routine status', () => {
    renderBand({ verdict: { level: 'critical', headline: 'Server crashed' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a calm verdict gets role="status" instead, not role="alert"', () => {
    renderBand({ verdict: { level: 'calm' } })
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a warning verdict also gets role="status", not "alert" -- only critical interrupts', () => {
    renderBand({ verdict: { level: 'warning', headline: 'Disk getting full' } })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('omits the headline block entirely when calm and nothing is wrong -- a healthy panel should not announce itself', () => {
    renderBand({ verdict: { level: 'calm' } })
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('reports a stale link instead of a falsely-fresh timestamp', () => {
    const old = new Date(Date.now() - 5 * 60_000)
    renderBand({ lastUpdated: old, stale: true })
    expect(screen.getByText(/link may be stale/)).toBeInTheDocument()
  })

  it('does not claim staleness when the link is fresh', () => {
    renderBand({ lastUpdated: new Date(), stale: false })
    expect(screen.queryByText(/link may be stale/)).not.toBeInTheDocument()
    expect(screen.getByText('updated just now')).toBeInTheDocument()
  })

  it('shows "no update yet" rather than a bogus elapsed time when there has never been an update', () => {
    renderBand({ lastUpdated: null, stale: false })
    expect(screen.getByText('no update yet')).toBeInTheDocument()
  })

  it('renders accented, non-ASCII player names verbatim', () => {
    renderBand({ players: [{ name: 'Aurélie', since: '5m' }] })
    expect(screen.getByText('Aurélie')).toBeInTheDocument()
  })

  it('caps the visible player list at 10 and reports the real overflow count, not a silently truncated list', () => {
    const players = Array.from({ length: 13 }, (_, i) => ({ name: `Player${i}` }))
    renderBand({ players })
    for (let i = 0; i < 10; i++) expect(screen.getByText(`Player${i}`)).toBeInTheDocument()
    expect(screen.queryByText('Player10')).not.toBeInTheDocument()
    expect(screen.getByText('and 3 more')).toBeInTheDocument()
  })

  it('hides the presence list entirely when showPresence is false, even with players online', () => {
    renderBand({ showPresence: false, players: [{ name: 'Aurélie' }] })
    expect(screen.queryByText('Aurélie')).not.toBeInTheDocument()
  })

  it('a Link-style action navigates via href, an onClick-style action calls the handler -- and neither is silently disabled', () => {
    const onClick = vi.fn()
    renderBand({
      verdict: { level: 'warning', headline: 'Fix me', action: { label: 'Fix it', onClick } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Fix it' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('a busy action is disabled and does not fire onClick', () => {
    const onClick = vi.fn()
    renderBand({
      verdict: { level: 'warning', headline: 'Fix me', action: { label: 'Fix it', onClick, busy: true } },
    })
    const btn = screen.getByRole('button', { name: 'Fix it' })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('a link-style action renders a real navigable link to the real destination', () => {
    renderBand({
      verdict: { level: 'warning', headline: 'Check backups', action: { label: 'Go to Backups', to: '/backups' } },
    })
    expect(screen.getByRole('link', { name: /Go to Backups/ })).toHaveAttribute('href', '/backups')
  })
})

describe('WorkList', () => {
  const Icon = (() => <svg />) as any

  it('renders each destination with its real live state and links to the real path', () => {
    const items: WorkItem[] = [
      { to: '/backups', icon: Icon, label: 'Backups', state: '3 pending', tone: 'warning' },
    ]
    render(
      <MemoryRouter>
        <WorkList items={items} />
      </MemoryRouter>
    )
    const link = screen.getByRole('link', { name: /Backups/ })
    expect(link).toHaveAttribute('href', '/backups')
    expect(screen.getByText('3 pending')).toHaveClass('text-warning')
  })

  it('a "bad" tone item is visually distinguished from a "good" one -- both cannot look the same', () => {
    const items: WorkItem[] = [
      { to: '/a', icon: Icon, label: 'A', state: 'broken', tone: 'bad' },
      { to: '/b', icon: Icon, label: 'B', state: 'fine', tone: 'good' },
    ]
    render(
      <MemoryRouter>
        <WorkList items={items} />
      </MemoryRouter>
    )
    expect(screen.getByText('broken')).toHaveClass('text-destructive')
    expect(screen.getByText('fine')).toHaveClass('text-success/80')
  })
})
