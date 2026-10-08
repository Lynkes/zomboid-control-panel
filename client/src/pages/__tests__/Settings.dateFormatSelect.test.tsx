import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi } from '@/lib/api'
import { DATE_FORMAT_STORAGE_KEY, getDateFormatPref, setDateFormatPref } from '@/lib/dateFormat'

// Settings > General > Appearance: the date format choice is per browser
// (localStorage, applied at once, no Save Settings), and each option shows
// a sample date in its own order.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

const getAppSettings = vi.spyOn(configApi, 'getAppSettings')

// The sample date: 31 December of this year.
const YEAR = new Date().getFullYear()

// The select is a Radix Select, which calls pointer-capture and
// scrollIntoView methods jsdom doesn't have.
const proto = Element.prototype as unknown as Record<string, unknown>
const polyfilled = ['hasPointerCapture', 'releasePointerCapture', 'setPointerCapture', 'scrollIntoView'].filter((name) => !(name in proto))

beforeEach(() => {
  for (const name of polyfilled) proto[name] = name === 'hasPointerCapture' ? () => false : () => {}
  getAppSettings.mockResolvedValue({ settings: {} } as never)
})

afterEach(() => {
  for (const name of polyfilled) delete proto[name]
  cleanup()
  vi.clearAllMocks()
  setDateFormatPref('auto')
  localStorage.clear()
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Settings.tsx: date format', () => {
  it('starts on Automatic, showing what this browser gives', async () => {
    renderSettings()
    const select = await screen.findByRole('combobox', { name: 'Date format' })
    expect(select).toHaveTextContent(`Automatic (12/31/${YEAR})`)
  })

  it('saves a choice at once and shows it in the select', async () => {
    renderSettings()
    const select = await screen.findByRole('combobox', { name: 'Date format' })

    fireEvent.pointerDown(select, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(await screen.findByRole('option', { name: `Month/Day/Year (12/31/${YEAR})` })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: `Year-Month-Day (${YEAR}-12-31)` })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: `Day/Month/Year (31/12/${YEAR})` }))

    await waitFor(() => expect(select).toHaveTextContent(`Day/Month/Year (31/12/${YEAR})`))
    expect(localStorage.getItem(DATE_FORMAT_STORAGE_KEY)).toBe('dmy')
    expect(getDateFormatPref()).toBe('dmy')
  })

  it('reflects a choice saved earlier in this browser', async () => {
    localStorage.setItem(DATE_FORMAT_STORAGE_KEY, 'ymd')
    renderSettings()
    const select = await screen.findByRole('combobox', { name: 'Date format' })
    expect(select).toHaveTextContent(`Year-Month-Day (${YEAR}-12-31)`)
  })
})
