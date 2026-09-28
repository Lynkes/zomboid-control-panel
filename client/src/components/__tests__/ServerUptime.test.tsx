import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import i18n from '@/i18n'
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

  // Review: the exact start used to be a `title`, which neither touch nor
  // keyboard can open -- on the phones this uptime is now shown on.
  it('names the exact start time in a tooltip a tap opens, on a machine-readable <time>', () => {
    const startedAt = iso(NOW - 3600_000)
    renderUptime(<ServerUptime startedAt={startedAt} />)

    const time = screen.getByText(up('1h')).closest('time')!
    expect(time).toHaveAttribute('dateTime', startedAt)
    expect(time).not.toHaveAttribute('title')
    expect(screen.queryByText(/^Started /)).not.toBeInTheDocument()

    fireEvent.click(time)

    expect(screen.getAllByText(/^Started /).length).toBeGreaterThan(0)
  })

  it('opens the start time tooltip from the keyboard alone', () => {
    renderUptime(<ServerUptime startedAt={iso(NOW - 3600_000)} />)
    const time = screen.getByText(up('1h')).closest('time')!

    act(() => { time.focus() })

    expect(time).toHaveFocus()
    expect(screen.getAllByText(/^Started /).length).toBeGreaterThan(0)
  })

  // Review: the API layer's skew correction leaves each response's own
  // latency in the start time, so two polls report the same process a few
  // hundred ms apart -- and at a display boundary the count stepped back.
  it('does not step backwards when a later poll reports the same start a little later', () => {
    const { rerender } = renderUptime(<ServerUptime startedAt={iso(NOW - 60_100)} />)
    expect(screen.getByText(up('1m'))).toBeInTheDocument()

    rerender(<TooltipProvider><ServerUptime startedAt={iso(NOW - 59_700)} /></TooltipProvider>)
    expect(screen.getByText(up('1m'))).toBeInTheDocument()

    // A real restart moves the start by far more than latency ever does.
    rerender(<TooltipProvider><ServerUptime startedAt={iso(NOW - 5_000)} /></TooltipProvider>)
    expect(screen.getByText(up('5s'))).toBeInTheDocument()
  })

  it('takes a slightly earlier report of the same start, which had less latency in it', () => {
    const { rerender } = renderUptime(<ServerUptime startedAt={iso(NOW - 59_500)} />)
    expect(screen.getByText(up('59s'))).toBeInTheDocument()

    rerender(<TooltipProvider><ServerUptime startedAt={iso(NOW - 60_200)} /></TooltipProvider>)
    expect(screen.getByText(up('1m'))).toBeInTheDocument()
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

// Review: the units came from CLDR's narrow forms through Intl -- "2г 3х" in
// Ukrainian and "1 T" in German, next to the same dashboard's own
// translated "год"/"хв" and "Tg." -- and varied with the browser's ICU
// build. They are the translators' now, like every other duration.
describe('ServerUptime: units in the UI language', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await i18n.changeLanguage('en')
  })

  const startedAt = iso(NOW - (26 * 3600 + 3 * 60) * 1000) // 1 day, 2 hours, 3 minutes

  it.each([
    ['uk', 'працює 1 дн 2 год 3 хв'],
    ['de', 'läuft seit 1 Tg. 2 Std. 3 Min.'],
    ['fr', 'actif depuis 1 j 2 h 3 min'],
    ['zh-CN', '已运行 1 天 2 小时 3 分钟'],
    ['ht', 'an fonksyone depi 1d 2h 3m'],
  ])("uses the %s locale file's own unit wording", async (language, expected) => {
    await act(async () => { await i18n.changeLanguage(language) })

    renderUptime(<ServerUptime startedAt={startedAt} />)

    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  // Arabic has a dual plural category: a count of 2 must still find the
  // unit, with Latin digits like every other number in the UI.
  it('words every count in Arabic, including the dual', async () => {
    await act(async () => { await i18n.changeLanguage('ar') })

    renderUptime(<ServerUptime startedAt={iso(NOW - (2 * 86400 + 2 * 3600) * 1000)} />)

    expect(screen.getByText('يعمل منذ 2 ي 2 س')).toBeInTheDocument()
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

  // Review: this used to fire a click after the Enter keyDown, so it passed
  // whether or not the keyboard did anything. Focus alone opens it.
  it('is reachable from the keyboard too', async () => {
    renderUptime(<ServerUptime startedAt={null} showUnknown />)
    const help = screen.getByRole('button', { name: helpName })

    act(() => { help.focus() })

    expect(help).toHaveFocus()
    await waitFor(() => expect(screen.getAllByText(en.unknownHint).length).toBeGreaterThan(0))
  })
})
