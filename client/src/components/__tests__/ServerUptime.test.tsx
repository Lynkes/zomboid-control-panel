import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ServerUptime } from '../ServerUptime'
import en from '@/locales/en/serverUptime.json'

// Discord request: "it would be nice if the panel showed server uptime on
// the dashboard". It did, as a duration the server computed at poll time --
// frozen between 15s polls and whenever polls failed -- and not at all
// whenever that duration was 0, which is what an unknown start time looked
// like. This counts from the start timestamp itself, and says "unknown" out
// loud where the caller knows the server is up.

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const up = (uptime: string) => en.up.replace('{{uptime}}', uptime)

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ServerUptime', () => {
  it('shows the uptime from the start time, in whole minutes past the first minute', () => {
    render(<ServerUptime startedAt={iso(NOW - (26 * 3600 + 3 * 60 + 42) * 1000)} />)

    expect(screen.getByText(up('1d 2h 3m'))).toBeInTheDocument()
  })

  it('keeps counting between polls instead of freezing on the last snapshot', () => {
    render(<ServerUptime startedAt={iso(NOW - (2 * 3600 + 59 * 60 + 30) * 1000)} />)
    expect(screen.getByText(up('2h 59m'))).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(30_000) })
    expect(screen.getByText(up('3h'))).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText(up('3h 1m'))).toBeInTheDocument()
  })

  it('counts seconds during the first minute after a start', () => {
    render(<ServerUptime startedAt={iso(NOW - 5_000)} />)
    expect(screen.getByText(up('5s'))).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText(up('6s'))).toBeInTheDocument()
  })

  it('names the exact start time on hover, as a machine-readable <time>', () => {
    const startedAt = iso(NOW - 3600_000)
    render(<ServerUptime startedAt={startedAt} />)

    const time = screen.getByText(up('1h')).closest('time')
    expect(time).toHaveAttribute('dateTime', startedAt)
    expect(time?.getAttribute('title')).toMatch(/^Started /)
  })

  it('renders nothing for an unknown start time by default -- never "up 0s"', () => {
    const { container } = render(<ServerUptime startedAt={null} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('says the uptime is unknown, and why, where the caller knows the server is up', () => {
    render(<ServerUptime startedAt={undefined} showUnknown />)

    const unknown = screen.getByText(en.unknown)
    expect(unknown.closest('[title]')).toHaveAttribute('title', en.unknownHint)
    expect(screen.queryByText(/^up /)).not.toBeInTheDocument()
  })

  it('treats an unparseable start time as unknown rather than guessing', () => {
    render(<ServerUptime startedAt="not a date" showUnknown />)

    expect(screen.getByText(en.unknown)).toBeInTheDocument()
  })
})
