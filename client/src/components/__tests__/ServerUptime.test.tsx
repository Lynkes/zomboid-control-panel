import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ServerUptime } from '../ServerUptime'
import en from '@/locales/en/serverUptime.json'
import helpTipEn from '@/locales/en/helpTip.json'

// Discord request: "it would be nice if the panel showed server uptime on
// the dashboard". It did, as a duration the server computed at poll time --
// frozen between 15s polls and whenever polls failed -- and not at all
// whenever that duration was 0, which is what an unknown start time looked
// like. This counts from the start timestamp itself, and says "unknown" out
// loud where the caller knows the server is up.

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const up = (uptime: string) => en.up.replace('{{uptime}}', uptime)

// HelpTip (the "why is it unknown" explanation) is a Radix tooltip, which
// needs the provider App.tsx mounts at the root.
function renderUptime(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('ServerUptime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the uptime from the start time, in whole minutes past the first minute', () => {
    renderUptime(<ServerUptime startedAt={iso(NOW - (26 * 3600 + 3 * 60 + 42) * 1000)} />)

    expect(screen.getByText(up('1d 2h 3m'))).toBeInTheDocument()
  })

  it('keeps counting between polls instead of freezing on the last snapshot', () => {
    renderUptime(<ServerUptime startedAt={iso(NOW - (2 * 3600 + 59 * 60 + 30) * 1000)} />)
    expect(screen.getByText(up('2h 59m'))).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(30_000) })
    expect(screen.getByText(up('3h'))).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText(up('3h 1m'))).toBeInTheDocument()
  })

  it('counts seconds during the first minute after a start', () => {
    renderUptime(<ServerUptime startedAt={iso(NOW - 5_000)} />)
    expect(screen.getByText(up('5s'))).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText(up('6s'))).toBeInTheDocument()
  })

  it('names the exact start time on hover, as a machine-readable <time>', () => {
    const startedAt = iso(NOW - 3600_000)
    renderUptime(<ServerUptime startedAt={startedAt} />)

    const time = screen.getByText(up('1h')).closest('time')
    expect(time).toHaveAttribute('dateTime', startedAt)
    expect(time?.getAttribute('title')).toMatch(/^Started /)
  })

  it('renders nothing for an unknown start time by default -- never "up 0s"', () => {
    const { container } = render(<ServerUptime startedAt={null} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('treats an unparseable start time as unknown rather than guessing', () => {
    renderUptime(<ServerUptime startedAt="not a date" showUnknown />)

    expect(screen.getByText(en.unknown)).toBeInTheDocument()
  })

  // A start time clearly in this browser's future is a clock problem, not
  // a server that just started: "up 0s" re-rendered every second until the
  // clocks crossed was a confident wrong answer.
  it('treats a start time well in the future as unknown, not "up 0s"', () => {
    renderUptime(<ServerUptime startedAt={iso(NOW + 5 * 60_000)} showUnknown />)

    expect(screen.getByText(en.unknown)).toBeInTheDocument()
    expect(screen.queryByText(up('0s'))).not.toBeInTheDocument()
  })
})

describe('ServerUptime: unknown, and why', () => {
  const helpName = helpTipEn.ariaLabel.replace('{{label}}', en.unknown)

  it('says the uptime is unknown where the caller knows the server is up, with the reason behind a help button', async () => {
    renderUptime(<ServerUptime startedAt={undefined} showUnknown />)

    expect(screen.getByText(en.unknown)).toBeInTheDocument()
    expect(screen.queryByText(/^up /)).not.toBeInTheDocument()
    expect(screen.queryByText(en.unknownHint)).not.toBeInTheDocument()
    // A real button, so a tap opens the reason -- a `title` on a span never
    // could, on the phones this header is now shown on.
    fireEvent.click(screen.getByRole('button', { name: helpName }))

    await waitFor(() => expect(screen.getAllByText(en.unknownHint).length).toBeGreaterThan(0))
  })

  it('is reachable from the keyboard too', async () => {
    renderUptime(<ServerUptime startedAt={null} showUnknown />)
    const help = screen.getByRole('button', { name: helpName })

    help.focus()
    fireEvent.keyDown(help, { key: 'Enter' })
    fireEvent.click(help)

    expect(help).toHaveFocus()
    await waitFor(() => expect(screen.getAllByText(en.unknownHint).length).toBeGreaterThan(0))
  })
})
