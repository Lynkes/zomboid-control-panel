import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi, panelBridgeApi } from '@/lib/api'

// Enum values run 1..N and the bridge sends N as `max`. After a panel update,
// a game server can still run the old PanelBridge Lua (1.7.70 or older) until
// the new file reaches it and the server restarts. The old Lua read labels
// from index 0 (the game rejects it), never asked for N, and dropped labels
// without a translation, so its list is shorter than max. Its
// setSandboxOption also saves N as N-1 and reports that as confirmed, so Mod
// Settings must not send N until PanelBridge is updated.

const toastSpy = vi.hoisted(() => vi.fn())

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true, isAuthenticated: true, isLoading: false,
    needsSetup: false, logout: vi.fn(), getToken: () => 'test-token', can: () => true,
  }),
}))
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({ on: vi.fn(), off: vi.fn() }),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  toastSpy.mockReset()
  localStorage.clear()
})

// What PanelBridge 1.7.70's setSandboxOption does with an enum value: it
// clamps as if values ran 0..N-1, then reports what the game kept.
function oldBridgeSetEnum(value: number, max: number) {
  let kept = Math.floor(value)
  if (kept >= max) kept = max - 1
  if (kept < 0) kept = 0
  return kept
}

async function openModSettings(
  option: Record<string, unknown>,
  keep: (value: number) => number = (value) => value,
) {
  vi.spyOn(serversApi, 'getResolvedActive').mockResolvedValue({
    server: { id: 's1', name: 'Test Server', serverName: 'test', isRemote: false },
  } as never)
  vi.spyOn(serversApi, 'getActive').mockResolvedValue({ server: null } as never)
  vi.spyOn(serverFilesApi, 'getPaths').mockResolvedValue({
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
  } as never)
  const getIni = vi.spyOn(serverFilesApi, 'getIni').mockResolvedValue({
    settings: { PVP: 'false' }, path: '/test', serverName: 'test',
  } as never)
  const saveSandboxOption = vi.spyOn(serverFilesApi, 'saveSandboxOption')
    .mockResolvedValue({ persisted: true } as never)
  const sendCommand = vi.spyOn(panelBridgeApi, 'sendCommand').mockImplementation(async (action, args) => {
    if (action === 'getAllSandboxOptions') {
      return { success: true, data: {
        options: { General: [{ name: 'General.TestOption', shortName: 'TestOption',
          tableName: 'General', type: 'enum', ...option }] },
        groups: [{ name: 'General', count: 1 }], totalCount: 1, enumerated: true,
      } } as never
    }
    const sent = (args as { value: number }).value
    return { success: true, data: {
      name: 'General.TestOption', value: keep(sent), type: 'enum', verified: 'confirmed', persisted: true,
    } } as never
  })

  render(<MemoryRouter initialEntries={['/server-config']}>
    <TooltipProvider><ServerConfig /></TooltipProvider>
  </MemoryRouter>)
  await waitFor(() => expect(getIni).toHaveBeenCalled())
  fireEvent.mouseDown(screen.getByRole('tab', { name: /mod settings/i }), { button: 0 })
  await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('getAllSandboxOptions', {}, expect.anything()))
  fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'TestOption' } })
  return { sendCommand, saveSandboxOption }
}

const setCalls = (sendCommand: { mock: { calls: unknown[][] } }) =>
  sendCommand.mock.calls.filter(([action]) => action === 'setSandboxOption')

// The option's row: its hint sits in the label column, next to the control.
const optionRow = (hint: HTMLElement) => hint.parentElement!.parentElement!

const CALLOUT_TITLE = 'This server runs an older PanelBridge'
const HINT_3 = "The last choice (3) can't be picked here until PanelBridge is updated."

describe('Mod Settings enum rows when the labels do not cover 1..max', () => {
  it('keeps the list and shows no callout when the bridge sends one label per value', async () => {
    await openModSettings({
      value: 3, selectedIndex: 3, min: 1, max: 3, enumValues: ['Never', 'Instant', 'Delayed'],
    })

    const select = await screen.findByRole('combobox', { name: 'Test Option' })
    expect(select).toHaveTextContent('Delayed')
    expect(select).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(CALLOUT_TITLE)).not.toBeInTheDocument()
  })

  it('lists choices 1..N-1 from an old bridge and holds the last one back', async () => {
    // jsdom has no layout; Radix scrolls the focused item when opening a Select.
    const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    try {
      // Index 0 always threw and nothing else was dropped: labels for 1..2.
      const { sendCommand } = await openModSettings(
        { value: 2, selectedIndex: 2, min: 1, max: 3, enumValues: ['Never', 'Instant'] },
        (value) => oldBridgeSetEnum(value, 3),
      )

      const select = await screen.findByRole('combobox', { name: 'Test Option' })
      expect(select).toHaveTextContent('Instant')
      expect(screen.getByText(CALLOUT_TITLE)).toBeInTheDocument()
      const hint = screen.getByText(HINT_3)
      expect(select).toHaveAttribute('aria-describedby', hint.id)

      fireEvent.keyDown(select, { key: 'ArrowDown' })
      const last = await screen.findByRole('option', { name: 'Choice 3' })
      expect(last).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(last)
      expect(setCalls(sendCommand)).toHaveLength(0)

      fireEvent.click(screen.getByRole('option', { name: 'Never' }))
      await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
        { name: 'General.TestOption', value: 1 }))
    } finally {
      if (previousScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  })

  it('edits the number when an old bridge dropped a label, and refuses the last choice', async () => {
    // Label 1 had no translation, so the old list is ['Instant'] and
    // position 1 no longer means value 1.
    const { sendCommand } = await openModSettings(
      { value: 2, selectedIndex: 2, min: 1, max: 3, enumValues: ['Instant'] },
      (value) => oldBridgeSetEnum(value, 3),
    )

    const input = await screen.findByRole('spinbutton', { name: 'Test Option' })
    expect(screen.queryByRole('combobox', { name: 'Test Option' })).not.toBeInTheDocument()
    expect(input).toHaveValue(2)
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '3')
    expect(input).toHaveAttribute('step', '1')
    expect(screen.getByText(CALLOUT_TITLE)).toBeInTheDocument()
    const hint = screen.getByText(HINT_3)
    expect(input).toHaveAttribute('aria-describedby', hint.id)

    // The old Lua would save 3 as 2 and call it confirmed.
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.blur(input)
    expect(setCalls(sendCommand)).toHaveLength(0)
    expect(input).toHaveValue(2)
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Update PanelBridge first',
      description: expect.stringContaining('General.TestOption wasn\'t changed'),
      variant: 'warning',
    }))

    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
      { name: 'General.TestOption', value: 1 }))
  })

  it('refuses a reset to a default that is the last choice while an old bridge runs', async () => {
    const { sendCommand } = await openModSettings(
      { value: 1, selectedIndex: 1, min: 1, max: 3, default: 3, enumValues: ['Never'] },
      (value) => oldBridgeSetEnum(value, 3),
    )

    fireEvent.click(await screen.findByRole('button', { name: /def: 3/ }))
    expect(setCalls(sendCommand)).toHaveLength(0)
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Update PanelBridge first' }))
  })

  it('shows the outdated-bridge callout when an old bridge read no label at all', async () => {
    await openModSettings({ value: 2, selectedIndex: 2, min: 1, max: 3, enumValues: [] })

    expect(await screen.findByRole('spinbutton', { name: 'Test Option' })).toHaveValue(2)
    expect(screen.getByText(CALLOUT_TITLE)).toBeInTheDocument()
    expect(screen.getByText(HINT_3)).toBeInTheDocument()
    // A restart alone doesn't load a newer bridge that isn't on disk yet
    // (hosted/SFTP servers, or auto-update off), so point at the status page.
    expect(screen.getByText(/Settings › PanelBridge shows what this server needs/)).toBeInTheDocument()
  })

  // An old bridge reads the current value with getValue, so selectedIndex can
  // already be N. Nothing on the row may present that live value as pending.
  it('shows a last choice the option already holds as set, in the list', async () => {
    await openModSettings({
      value: 2, selectedIndex: 2, min: 1, max: 2, default: 2, enumValues: ['Off'],
    })

    const select = await screen.findByRole('combobox', { name: 'Test Option' })
    expect(select).toHaveTextContent(/^Choice 2$/)
    const hint = screen.getByText("The last choice (2) can't be picked here until PanelBridge is updated.")
    expect(select).toHaveAttribute('aria-describedby', hint.id)
    expect(optionRow(hint).textContent).not.toMatch(/restart/i)
  })

  it('shows a last choice the option already holds as set, in the number input', async () => {
    const { sendCommand } = await openModSettings(
      { value: 3, selectedIndex: 3, min: 1, max: 3, default: 1, enumValues: ['Instant'] },
      (value) => oldBridgeSetEnum(value, 3),
    )

    const input = await screen.findByRole('spinbutton', { name: 'Test Option' })
    expect(input).toHaveValue(3)
    expect(optionRow(screen.getByText(HINT_3)).textContent).not.toMatch(/restart/i)

    // Leaving the held value untouched sends nothing and refuses nothing.
    fireEvent.blur(input)
    expect(setCalls(sendCommand)).toHaveLength(0)
    expect(toastSpy).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
      { name: 'General.TestOption', value: 1 }))
  })

  it('edits the number past the bridge label cap, with a note and no outdated-bridge callout', async () => {
    // A current bridge lists at most 50 labels, so values 51..60 have no item.
    const { sendCommand } = await openModSettings({
      value: 55, selectedIndex: 55, min: 1, max: 60,
      enumValues: Array.from({ length: 50 }, (_, i) => `Label ${i + 1}`),
    })

    const input = await screen.findByRole('spinbutton', { name: 'Test Option' })
    expect(input).toHaveValue(55)
    const note = screen.getByText(/Too many choices to list/)
    expect(input).toHaveAttribute('aria-describedby', note.id)
    expect(screen.queryByText(CALLOUT_TITLE)).not.toBeInTheDocument()

    // Nothing is held back on a current bridge: the last value goes through.
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
      { name: 'General.TestOption', value: 60 }))
  })
})

describe('Mod Settings when the server keeps a different value', () => {
  it('names the value the server kept and saves that one, not the one sent', async () => {
    // An integer option: the bridge floors 2.5 to 2 and still reports success.
    const { sendCommand, saveSandboxOption } = await openModSettings(
      { type: 'number', value: 4, min: 0, max: 10 },
      (value) => Math.floor(value),
    )

    const input = await screen.findByRole('spinbutton', { name: 'Test Option' })
    fireEvent.change(input, { target: { value: '2.5' } })
    fireEvent.blur(input)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
      { name: 'General.TestOption', value: 2.5 }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith({
      title: 'Server kept a different value',
      description: 'General.TestOption: you asked for 2.5, but the server kept 2.',
      variant: 'warning',
    }))
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Option Updated' }))
    await waitFor(() => expect(saveSandboxOption).toHaveBeenCalledWith('General.TestOption', 2))
  })

  it('still says "Option Updated" when the server kept the value sent', async () => {
    const { sendCommand } = await openModSettings({ type: 'number', value: 4, min: 0, max: 10 })

    const input = await screen.findByRole('spinbutton', { name: 'Test Option' })
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.blur(input)
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith('setSandboxOption',
      { name: 'General.TestOption', value: 7 }))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Option Updated' })))
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Server kept a different value' }))
  })
})
