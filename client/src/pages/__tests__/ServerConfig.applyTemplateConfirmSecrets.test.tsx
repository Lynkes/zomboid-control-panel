import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'
import en from '../../locales/en/serverconfig.json'
import de from '../../locales/de/serverconfig.json'
import es from '../../locales/es/serverconfig.json'
import fr from '../../locales/fr/serverconfig.json'
import ht from '../../locales/ht/serverconfig.json'
import ptBR from '../../locales/pt-BR/serverconfig.json'
import uk from '../../locales/uk/serverconfig.json'
import zhCN from '../../locales/zh-CN/serverconfig.json'
import zhTW from '../../locales/zh-TW/serverconfig.json'
import ar from '../../locales/ar/serverconfig.json'

// Applying a saved config used to remove the live server's RCON password,
// server password and every token (the saved config holds none of them and
// the apply wrote it over the live .ini as it was), and the confirm dialog
// said only "applying this one will remove your server's RCON password --
// you'll need to re-enter it afterward". Apply now keeps the live file's
// secret lines (server: keepLiveSecretIniLines()), so the dialog says that.

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

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getTemplates = vi.spyOn(serverFilesApi, 'getTemplates')
const applyTemplate = vi.spyOn(serverFilesApi, 'applyTemplate')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

function mockLoads() {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: null } as never)
  getPaths.mockResolvedValue({
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
  } as never)
  getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
  getTemplates.mockResolvedValue({
    templates: [
      { id: 'with-ini', name: 'Has INI', description: '', type: 'ini', created: '2026-01-01T00:00:00.000Z', hasIni: true, hasSandbox: false },
      { id: 'sandbox-only', name: 'Sandbox only', description: '', type: 'sandbox', created: '2026-01-01T00:00:00.000Z', hasIni: false, hasSandbox: true },
    ],
  } as never)
  applyTemplate.mockResolvedValue({ success: true, applied: ['INI'], message: 'Applied INI settings' } as never)
}

async function openSavedConfigs() {
  mockLoads()
  render(
    <MemoryRouter initialEntries={['/server-config']}>
      <ConfirmProvider>
        <TooltipProvider>
          <ServerConfig />
        </TooltipProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(getIni).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: /^config snapshots$/i }))
  return screen.findByRole('dialog')
}

function applyButtonOf(dialog: HTMLElement, templateName: string) {
  const row = within(dialog).getByRole('heading', { name: templateName }).closest('div.rounded-lg') as HTMLElement
  return within(row).getByRole('button', { name: en.templatesDialog.apply })
}

describe('ServerConfig -- applying a saved config says the live passwords and tokens stay', () => {
  it('a saved config with INI settings tells the operator the RCON password, server password and tokens are kept', async () => {
    const dialog = await openSavedConfigs()

    fireEvent.click(applyButtonOf(dialog, 'Has INI'))

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(within(confirmDialog).getByText(/Replace your current server settings/)).toBeInTheDocument()
    expect(confirmDialog.textContent).toContain(en.applyTemplateConfirm.secretsKept)
    // ...and not the old claim that apply removes the RCON password.
    expect(confirmDialog.textContent).not.toMatch(/will remove your server's RCON password/)
    expect(confirmDialog.textContent).not.toMatch(/re-enter/)

    fireEvent.click(within(confirmDialog).getByRole('button', { name: en.applyTemplateConfirm.confirmLabel }))
    await waitFor(() => expect(applyTemplate).toHaveBeenCalledWith('with-ini'))
  })

  it('a saved config with no INI settings has nothing to say about secrets', async () => {
    const dialog = await openSavedConfigs()

    fireEvent.click(applyButtonOf(dialog, 'Sandbox only'))

    const confirmDialog = await screen.findByRole('alertdialog')
    expect(confirmDialog.textContent).not.toContain(en.applyTemplateConfirm.secretsKept)
  })
})

describe('applyTemplateConfirm.secretsKept exists in every language, and the old rconWarning is gone', () => {
  const locales = { en, de, es, fr, ht, 'pt-BR': ptBR, uk, 'zh-CN': zhCN, 'zh-TW': zhTW, ar }

  it.each(Object.entries(locales))('%s', (_name, strings) => {
    const confirm = strings.applyTemplateConfirm as Record<string, string>
    expect(typeof confirm.secretsKept).toBe('string')
    expect(confirm.secretsKept.length).toBeGreaterThan(20)
    expect(confirm).not.toHaveProperty('rconWarning')
  })
})
