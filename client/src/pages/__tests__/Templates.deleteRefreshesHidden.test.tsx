import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Templates from '../Templates'
import { templatesApi, SimTemplate } from '@/lib/api'

// Hiding a built-in template (the "delete" action on a built-in card) moves
// it into the "hidden templates" section. handleDelete used to refetch only
// the main list, so the section with the Restore button stayed stale until a
// page reload.

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

vi.mock('@/contexts/ConfirmContext', () => ({
  useConfirm: () => async () => true,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    templatesApi: {
      ...actual.templatesApi,
      list: vi.fn(),
      listHidden: vi.fn(),
      delete: vi.fn(),
    },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const listTemplates = vi.mocked(templatesApi.list)
const listHidden = vi.mocked(templatesApi.listHidden)
const deleteTemplate = vi.mocked(templatesApi.delete)

function makeBuiltin(): SimTemplate {
  return {
    schemaVersion: 1,
    meta: { id: 'vanilla-apocalypse', name: 'Vanilla Apocalypse', description: '', tags: [] },
    isBuiltin: true,
    difficulty: {},
    mods: [],
    serverIni: {},
    sandboxVars: {},
    iniExclusions: [],
    map: { mapId: 'Muldraugh, KY' },
  } as unknown as SimTemplate
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Templates.tsx -- hiding a built-in refreshes the hidden section', () => {
  it('shows the Restore control for the just-hidden built-in without a reload', async () => {
    listTemplates.mockResolvedValueOnce({ templates: [makeBuiltin()] })
    listTemplates.mockResolvedValue({ templates: [] })
    listHidden.mockResolvedValueOnce({ templates: [] })
    listHidden.mockResolvedValue({ templates: [makeBuiltin()] })
    deleteTemplate.mockResolvedValue({ success: true })

    render(
      <MemoryRouter>
        <Templates />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTitle('Delete template'))

    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith('vanilla-apocalypse'))
    expect(
      await screen.findByRole('button', { name: 'Restore Vanilla Apocalypse' }),
    ).toBeInTheDocument()
    expect(listHidden).toHaveBeenCalledTimes(2)
  })
})
