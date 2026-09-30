import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import i18n from '@/i18n'
import arFiles from '@/locales/ar/files.json'
import enFiles from '@/locales/en/files.json'
import { FakeFilesServer, makeEntry, makeListing, makeText, renderFiles, stubLayout } from './filesTestHarness'

// Spec §A14.2/§A14.5: in Arabic every name, path and the editor stay
// left-to-right inside the right-to-left page; on a phone the folders become
// a Select, rows carry "size · date" on a second line, and the bulk bar
// sticks to the bottom of the screen.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'kate', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'token',
    can: () => true,
  }),
}))

const INI = makeEntry('Server/servertest.ini')

let server: FakeFilesServer
let restoreLayout: () => void

beforeEach(() => {
  server = new FakeFilesServer()
  server.install()
  restoreLayout = stubLayout()
  server.listings.set('data|Server', makeListing([INI, makeEntry('Server/servertest_SandboxVars.lua')]))
  server.texts.set('data|Server/servertest.ini', makeText(INI, 'PVP=true\n'))
})

afterEach(async () => {
  cleanup()
  restoreLayout()
  vi.unstubAllGlobals()
  localStorage.clear()
  await i18n.changeLanguage('en')
})

function mockViewport(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 768px') ? desktop : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }))
}

describe('Files in Arabic (right-to-left)', () => {
  beforeEach(async () => {
    mockViewport(true)
    await i18n.changeLanguage('ar')
  })

  it('keeps names, the breadcrumb path and the editor left-to-right', async () => {
    expect(document.documentElement.dir).toBe('rtl')
    renderFiles('/files?server=p1&root=data&path=Server')

    const nameButton = await screen.findByRole('button', { name: 'servertest.ini' })
    expect(nameButton.querySelector('bdi')).toHaveAttribute('dir', 'ltr')
    for (const bdi of within(screen.getByRole('table')).getAllByText(/servertest/, { selector: 'bdi' })) {
      expect(bdi).toHaveAttribute('dir', 'ltr')
    }
    const crumb = within(screen.getByRole('navigation', { name: arFiles.list.breadcrumbLabel })).getByText('Server')
    expect(crumb.closest('bdi')).toHaveAttribute('dir', 'ltr')

    fireEvent.click(nameButton)
    const editor = await screen.findByRole('textbox', { name: 'servertest.ini' })
    expect(editor).toHaveAttribute('dir', 'ltr')
    expect(editor.parentElement).toHaveAttribute('dir', 'ltr')
  })

  it('mirrors direction-bearing icons', async () => {
    renderFiles('/files?server=p1&root=data&path=Server')
    const nav = await screen.findByRole('navigation', { name: arFiles.list.breadcrumbLabel })
    expect(nav.querySelector('svg')?.getAttribute('class')).toContain('rtl:-scale-x-100')
  })
})

describe('Files on a phone', () => {
  beforeEach(() => {
    mockViewport(false)
  })

  it('shows the folders as a Select, rows with a second line, and no folder cards', async () => {
    renderFiles('/files?server=p1&root=data&path=Server')
    await screen.findByRole('button', { name: /^servertest\.ini/ })
    expect(screen.getByRole('combobox', { name: enFiles.roots.heading })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Game install folder/ })).not.toBeInTheDocument()
    const row = screen.getByRole('button', { name: /^servertest\.ini/ })
    expect(row).toHaveTextContent(/1\.2 kB · /)
  })

  it('keeps only the last two crumbs, the rest behind "More folders"', async () => {
    server.listings.set('data|Saves/Multiplayer/servertest', makeListing([makeEntry('Saves/Multiplayer/servertest/map_t.bin')]))
    renderFiles('/files?server=p1&root=data&path=Saves/Multiplayer/servertest')
    const nav = await screen.findByRole('navigation', { name: enFiles.list.breadcrumbLabel })
    await within(nav).findByText('servertest')
    expect(within(nav).getByRole('button', { name: 'Multiplayer' })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Zomboid folder' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Saves' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: enFiles.list.breadcrumbMore })).toBeInTheDocument()
  })

  it('pins the bulk bar to the bottom of the screen', async () => {
    renderFiles('/files?server=p1&root=data&path=Server')
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select servertest.ini' }))
    const bar = await screen.findByRole('region', { name: '1 selected' })
    expect(bar.className).toMatch(/\bfixed\b/)
    expect(bar.className).toMatch(/\bbottom-0\b/)
    expect(within(bar).getByRole('button', { name: enFiles.actions.downloadZip })).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: enFiles.actions.clearSelection }))
    await waitFor(() => expect(screen.queryByRole('region', { name: '1 selected' })).not.toBeInTheDocument())
  })
})
