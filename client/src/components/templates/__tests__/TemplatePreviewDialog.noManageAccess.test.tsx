import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TemplatePreviewDialog } from '../TemplatePreviewDialog'
import { serverApi, serversApi, templatesApi, type ServerInstance, type SimTemplate } from '@/lib/api'
import en from '../../../locales/en/templatePreviewDialog.json'

// SECURITY (2026-10-20, access-control audit): POST /templates/:id/preview
// reads the server's live settings and now needs templates.manage. A role
// without it opens the dialog to a note instead of a request the server
// would refuse.

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn(), getComposedStatus: vi.fn() },
    templatesApi: { ...actual.templatesApi, preview: vi.fn(), apply: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const server = { id: 1, name: 'Local', serverName: 'local', isRemote: false, isActive: true } as unknown as ServerInstance

const template: SimTemplate = {
  schemaVersion: 1,
  meta: { id: 'tpl-1', name: 'Test Template', description: '', tags: [], pzBuild: '42' },
  sandboxVars: {},
  serverIni: { PVP: false },
  iniExclusions: [],
  mods: [],
  map: { mapId: 'Muldraugh, KY' },
  difficulty: {},
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TemplatePreviewDialog without templates.manage', () => {
  it('shows the permission note and never requests the preview', async () => {
    vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server })
    vi.mocked(serverApi.getStatus).mockResolvedValue({ running: false } as never)
    vi.mocked(serversApi.getComposedStatus).mockResolvedValue({} as never)

    render(<TemplatePreviewDialog template={template} canManage={false} onClose={vi.fn()} onApplied={vi.fn()} />)

    expect(await screen.findByText(en.previewNoAccessTitle)).toBeInTheDocument()
    expect(screen.getByText(en.previewNoAccessDesc)).toBeInTheDocument()
    expect(templatesApi.preview).not.toHaveBeenCalled()
  })
})
