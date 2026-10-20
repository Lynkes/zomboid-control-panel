import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Templates from '../Templates'
import { templatesApi, SimTemplate } from '@/lib/api'

// UX restructure (slice B, Templates): one name ("Templates"), the header
// says how a template differs from a config snapshot and links to where
// snapshots live, the header stays while the list loads, and each card has
// one visible action (Preview & apply) with Export / Delete in its "…" menu.

let mockCan = (_capability: string) => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    templatesApi: { ...actual.templatesApi, list: vi.fn(), listHidden: vi.fn(), downloadExport: vi.fn() },
  }
})

const listTemplates = vi.mocked(templatesApi.list)
const listHidden = vi.mocked(templatesApi.listHidden)
const downloadExport = vi.mocked(templatesApi.downloadExport)

function makeCustom(): SimTemplate {
  return {
    schemaVersion: 1,
    meta: { id: 'my-rules', name: 'My Rules', description: 'Hard mode', tags: [] },
    isBuiltin: false,
    difficulty: {},
    mods: [],
    serverIni: {},
    sandboxVars: {},
    iniExclusions: [],
    map: { mapId: 'Muldraugh, KY' },
  } as unknown as SimTemplate
}

function renderTemplates() {
  return render(
    <MemoryRouter>
      <Templates />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockCan = () => true
})

describe('Templates header', () => {
  it('is titled Templates and links to the config snapshots in Server Configuration', async () => {
    listTemplates.mockResolvedValue({ templates: [] })
    listHidden.mockResolvedValue({ templates: [] })
    renderTemplates()
    expect(await screen.findByRole('heading', { level: 1, name: 'Templates' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Config snapshots live in Server Configuration/ })).toHaveAttribute(
      'href',
      '/server-config?open=snapshots',
    )
  })

  it('keeps the header and its actions while the list loads', () => {
    listTemplates.mockReturnValue(new Promise(() => {}))
    listHidden.mockResolvedValue({ templates: [] })
    renderTemplates()
    expect(screen.getByRole('heading', { level: 1, name: 'Templates' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Current Config' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading templates' })).toHaveAttribute('aria-busy', 'true')
  })
})

describe('TemplateCard actions', () => {
  it('shows Preview & apply and puts Export and Delete in the card menu', async () => {
    listTemplates.mockResolvedValue({ templates: [makeCustom()] })
    listHidden.mockResolvedValue({ templates: [] })
    renderTemplates()

    expect(await screen.findByRole('button', { name: 'Preview & apply' })).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for My Rules' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Export template', 'Delete template'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export template' }))
    expect(downloadExport).toHaveBeenCalledWith('my-rules', 'my-rules')
  })

  it('offers no Delete to a role without templates.manage', async () => {
    mockCan = () => false
    listTemplates.mockResolvedValue({ templates: [makeCustom()] })
    renderTemplates()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Actions for My Rules' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Export template'])
  })
})
