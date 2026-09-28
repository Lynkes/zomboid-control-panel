import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError, panelBridgeApi, serverApi } from '@/lib/api'
import type { DeliveryMethod, DeliveryPlanResponse, DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import en from '@/locales/en/bridgeDelivery.json'
import enSettings from '@/locales/en/settings.json'
import { BridgeDeliverySwitchDialog } from '../BridgeDeliverySwitchDialog'
import { makeLocalStatus, makePlan, makeWorkshopStatus, WORKSHOP_ID } from './deliveryFixtures'

let mockCan: (capability: string) => boolean = () => true

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'admin', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: (capability: string) => mockCan(capability),
  }),
}))

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastMock, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    panelBridgeApi: { ...actual.panelBridgeApi, planDelivery: vi.fn(), applyDelivery: vi.fn() },
    serverApi: { ...actual.serverApi, start: vi.fn(), restart: vi.fn() },
  }
})

const planDelivery = vi.mocked(panelBridgeApi.planDelivery)
const applyDelivery = vi.mocked(panelBridgeApi.applyDelivery)
const restart = vi.mocked(serverApi.restart)
const start = vi.mocked(serverApi.start)

const INI = 'C:\\Users\\op\\Zomboid\\Server\\servertest.ini'

function renderDialog(
  status: DeliveryStatus,
  { to = 'workshop', playerCount = null }: { to?: DeliveryMethod; playerCount?: number | null } = {},
) {
  const onOpenChange = vi.fn()
  const onChanged = vi.fn()
  const tree = (next: DeliveryStatus) => (
    <MemoryRouter>
      <TooltipProvider>
        <BridgeDeliverySwitchDialog
          open
          onOpenChange={onOpenChange}
          status={next}
          to={to}
          playerCount={playerCount}
          iniFileName="servertest.ini"
          onChanged={onChanged}
        />
      </TooltipProvider>
    </MemoryRouter>
  )
  const { rerender } = render(tree(status))
  return { onOpenChange, onChanged, rerenderWith: (next: DeliveryStatus) => rerender(tree(next)) }
}

async function stepsList() {
  return screen.findByTestId('bridge-delivery-steps')
}

beforeEach(() => {
  mockCan = () => true
  applyDelivery.mockImplementation(async (body) => makePlan({ applied: true, from: body.expectedFrom, to: body.method }))
  restart.mockResolvedValue({})
  start.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BridgeDeliverySwitchDialog: the preview lists every step, in order, with exact values', () => {
  it('renders every step kind with its paths and values', async () => {
    planDelivery.mockResolvedValue(
      makePlan({
        from: 'workshop',
        to: 'local',
        steps: [
          { kind: 'installFile', file: 'D:\\PZServer\\media\\lua\\server\\PanelBridge.lua', version: '1.7.71' },
          { kind: 'iniRemove', key: 'Mods', value: 'ZomboidControlPanelBridge', file: INI, serverName: 'Main Server' },
          { kind: 'iniRemove', key: 'WorkshopItems', value: WORKSHOP_ID, file: INI, serverName: 'Main Server' },
          { kind: 'iniSet', key: 'DoLuaChecksum', value: 'false', before: null, file: INI, serverName: 'Main Server' },
          { kind: 'iniAdd', key: 'Mods', value: 'ZomboidControlPanelBridge', file: 'E:\\other.ini', serverName: 'Second' },
          { kind: 'archiveFile', file: 'D:\\PZServer\\media\\lua\\client\\PanelBridgeClient.lua', fileKind: 'client', recognized: false },
          { kind: 'archiveFile', file: 'D:\\PZServer\\mod.info', fileKind: 'rootModInfo', recognized: true },
          { kind: 'recordMethod', method: 'local', servers: ['Main Server'] },
        ],
      }),
    )
    renderDialog(makeWorkshopStatus(), { to: 'local' })
    const list = await stepsList()
    const items = within(list).getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-step-kind'))).toEqual([
      'installFile', 'iniRemove', 'iniRemove', 'iniSet', 'iniAdd', 'archiveFile', 'archiveFile', 'recordMethod',
    ])
    expect(items[0]).toHaveTextContent('Copy PanelBridge v1.7.71 into D:\\PZServer\\media\\lua\\server\\PanelBridge.lua')
    expect(items[1]).toHaveTextContent(`Remove ZomboidControlPanelBridge from Mods= in ${INI} (Main Server)`)
    expect(items[2]).toHaveTextContent(`Remove ${WORKSHOP_ID} from WorkshopItems= in ${INI}`)
    expect(items[3]).toHaveTextContent(`Set DoLuaChecksum=false in ${INI}`)
    expect(items[4]).toHaveTextContent('Add ZomboidControlPanelBridge to Mods= in E:\\other.ini (Second)')
    expect(items[5]).toHaveTextContent('not written by this panel')
    expect(items[6]).toHaveTextContent('Move D:\\PZServer\\mod.info out of the game folder')
    expect(items[6]).not.toHaveTextContent('not written by this panel')
    expect(items[7]).toHaveTextContent(en.step.recordMethodLocal)
    expect(screen.getByText(en.dialog.backupNote)).toBeInTheDocument()
    expect(within(items[1]).getByText('ZomboidControlPanelBridge').tagName).toBe('CODE')
  })

  it('titles the dialog with the server and shows the plan warnings', async () => {
    planDelivery.mockResolvedValue(
      makePlan({ warnings: ['serverRunning', 'sharedInstall'], sharedWith: [{ id: 'srv-2', name: 'Second' }] }),
    )
    renderDialog(makeLocalStatus())
    await stepsList()
    expect(screen.getByRole('heading', { name: en.dialog.titleToWorkshop.replace('{{server}}', 'Main Server') })).toBeInTheDocument()
    expect(screen.getByText(en.warn.serverRunning)).toBeInTheDocument()
    expect(screen.getByText(en.warn.sharedInstall.replace('{{servers}}', 'Second'))).toBeInTheDocument()
  })

  it('a blocked plan disables every apply button and says why', async () => {
    planDelivery.mockResolvedValue(makePlan({ blocked: { reason: 'iniDuplicateKeys' }, steps: [] }))
    renderDialog(makeLocalStatus())
    expect((await screen.findAllByText(en.unavailable.iniDuplicateKeys)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: en.dialog.applyOnly })).toBeDisabled()
    expect(screen.getByRole('button', { name: en.dialog.applyRestartEmpty })).toBeDisabled()
    // No "makes these changes, in this order:" over a list that isn't there.
    expect(screen.queryByText(en.dialog.intro)).toBeNull()
  })

  it('heads a real list of steps with the intro, and nothing while the preview loads', async () => {
    let resolvePlan: (plan: DeliveryPlanResponse) => void = () => {}
    planDelivery.mockReturnValueOnce(new Promise((resolve) => { resolvePlan = resolve }))
    renderDialog(makeLocalStatus())
    expect(await screen.findByText(en.dialog.planning)).toBeInTheDocument()
    expect(screen.queryByText(en.dialog.intro)).toBeNull()
    resolvePlan(makePlan())
    await stepsList()
    expect(screen.getByText(en.dialog.intro)).toBeInTheDocument()
  })

  // lib/demo.ts acknowledges every POST it has no route for with
  // { success: true, message }; rendered as a plan, `steps.length` threw.
  it('an answer that is not a plan shows the preview error, not a crash', async () => {
    planDelivery.mockResolvedValue({ success: true, message: 'Demo mode' } as unknown as DeliveryPlanResponse)
    renderDialog(makeLocalStatus())
    expect(await screen.findByText(en.dialog.planFailed)).toBeInTheDocument()
    expect(screen.getByText(en.unexpectedResponse)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.dialog.applyOnly })).toBeDisabled()
  })
})

describe('BridgeDeliverySwitchDialog: apply', () => {
  it('sends expectedFrom from the preview, then restarts with a 5-minute warning when players are online', async () => {
    planDelivery.mockResolvedValue(makePlan())
    const { onOpenChange, onChanged } = renderDialog(makeLocalStatus(), { playerCount: 4 })
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyRestartPlayers }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(5))
    expect(applyDelivery).toHaveBeenCalledWith({ serverId: 'srv-1', method: 'workshop', expectedFrom: 'local' })
    expect(applyDelivery.mock.invocationCallOrder[0]).toBeLessThan(restart.mock.invocationCallOrder[0])
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onChanged).toHaveBeenCalled()
  })

  it('restarts immediately when nobody is online', async () => {
    planDelivery.mockResolvedValue(makePlan())
    renderDialog(makeLocalStatus(), { playerCount: 0 })
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyRestartEmpty }))
    await waitFor(() => expect(restart).toHaveBeenCalledWith(0))
  })

  it('starts a stopped server after the switch', async () => {
    planDelivery.mockResolvedValue(makePlan())
    renderDialog(makeLocalStatus({ serverRunning: false, live: null }))
    await stepsList()
    expect(screen.queryByRole('button', { name: en.dialog.applyRestartEmpty })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyStart }))
    await waitFor(() => expect(start).toHaveBeenCalled())
    expect(restart).not.toHaveBeenCalled()
  })

  it('"Switch, restart later" applies and touches nothing else', async () => {
    planDelivery.mockResolvedValue(makePlan())
    renderDialog(makeLocalStatus())
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyOnly }))
    await waitFor(() => expect(applyDelivery).toHaveBeenCalled())
    expect(restart).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('on 409 PANELBRIDGE_DELIVERY_STALE it re-plans instead of retrying the stale steps', async () => {
    planDelivery
      .mockResolvedValueOnce(makePlan())
      .mockResolvedValueOnce(makePlan({ from: 'workshop', blocked: { reason: 'sameMethod' }, steps: [] }))
    applyDelivery.mockRejectedValueOnce(
      new ApiError('changed', { status: 409, code: 'PANELBRIDGE_DELIVERY_STALE', data: { code: 'PANELBRIDGE_DELIVERY_STALE', params: { current: 'workshop' } } }),
    )
    const { onChanged, onOpenChange } = renderDialog(makeLocalStatus())
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyRestartEmpty }))
    expect(await screen.findByText(en.dialog.staleNotice)).toBeInTheDocument()
    await waitFor(() => expect(planDelivery).toHaveBeenCalledTimes(2))
    expect(applyDelivery).toHaveBeenCalledTimes(1)
    expect(restart).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(await screen.findAllByText(en.unavailable.sameMethod)).not.toHaveLength(0)
  })

  it('any other apply error is a toast, and nothing restarts', async () => {
    planDelivery.mockResolvedValue(makePlan())
    applyDelivery.mockRejectedValueOnce(new ApiError('nope', { status: 500, code: 'PANELBRIDGE_DELIVERY_INI_WRITE_FAILED' }))
    renderDialog(makeLocalStatus())
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyRestartEmpty }))
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.toast.switchFailed, variant: 'destructive' })))
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ description: en.toast.notRestored }))
    expect(screen.queryByTestId('bridge-delivery-not-restored')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })

  it('a failed apply whose undo did not complete (restored:false) says so instead of "put back", naming the file', async () => {
    planDelivery.mockResolvedValue(makePlan())
    applyDelivery.mockRejectedValueOnce(
      new ApiError("Couldn't update servertest.ini. The panel put back what it had already changed.", {
        status: 500,
        code: 'PANELBRIDGE_DELIVERY_INI_WRITE_FAILED',
        data: { code: 'PANELBRIDGE_DELIVERY_INI_WRITE_FAILED', params: { fileName: 'servertest.ini' }, restored: false },
      }),
    )
    renderDialog(makeLocalStatus())
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyOnly }))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: en.toast.switchFailed,
          description: en.toast.notRestoredFile.replace('{{fileName}}', 'servertest.ini'),
          variant: 'destructive',
        }),
      ),
    )
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringMatching(/put back what/) }))
    // The toast times out; the dialog keeps the warning until it closes,
    // and re-plans from the files as they are now.
    expect(await screen.findByTestId('bridge-delivery-not-restored')).toHaveTextContent(
      en.toast.notRestoredFile.replace('{{fileName}}', 'servertest.ini'),
    )
    await waitFor(() => expect(planDelivery).toHaveBeenCalledTimes(2))
  })

  it('restored:false without a file name keeps the generic not-restored text', async () => {
    planDelivery.mockResolvedValue(makePlan())
    applyDelivery.mockRejectedValueOnce(
      new ApiError('failed', { status: 500, code: 'PANELBRIDGE_DELIVERY_INSTALL_FAILED', data: { code: 'PANELBRIDGE_DELIVERY_INSTALL_FAILED', restored: false } }),
    )
    renderDialog(makeLocalStatus())
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyOnly }))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.toast.switchFailed, description: en.toast.notRestored })),
    )
  })

  it('reports a failed restart separately: the switch itself already happened', async () => {
    planDelivery.mockResolvedValue(makePlan())
    restart.mockRejectedValueOnce(new ApiError('busy', { status: 409, code: 'SERVER_LIFECYCLE_IN_PROGRESS' }))
    renderDialog(makeLocalStatus())
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyRestartEmpty }))
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.toast.lifecycleFailed })))
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: en.toast.switchedToWorkshop.replace('{{server}}', 'Main Server') }),
    )
  })
})

// useBridgeDelivery follows whatever server is active; another tab can
// switch it while this preview is open.
describe('BridgeDeliverySwitchDialog: the active server changes while it is open', () => {
  it('closes instead of rebuilding the preview for the other server', async () => {
    planDelivery.mockResolvedValue(makePlan())
    const { onOpenChange, rerenderWith } = renderDialog(makeLocalStatus())
    await stepsList()
    rerenderWith(makeLocalStatus({ serverId: 'srv-2', serverName: 'Second' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: en.dialog.serverChanged }))
    expect(planDelivery).toHaveBeenCalledTimes(1)
    expect(planDelivery).toHaveBeenCalledWith({ serverId: 'srv-1', method: 'workshop' })
    // The title still names the server the preview is for.
    expect(screen.getByRole('heading', { name: en.dialog.titleToWorkshop.replace('{{server}}', 'Main Server') })).toBeInTheDocument()
  })

  // /server/restart acts on whatever is active: after the switch of the
  // first server, restarting would hit the second.
  it('a switch applied while the server changed skips the restart and says so', async () => {
    planDelivery.mockResolvedValue(makePlan())
    let resolveApply: (plan: DeliveryPlanResponse) => void = () => {}
    applyDelivery.mockReturnValueOnce(new Promise((resolve) => { resolveApply = resolve }))
    const { onOpenChange, rerenderWith } = renderDialog(makeLocalStatus())
    await stepsList()
    fireEvent.click(screen.getByRole('button', { name: en.dialog.applyRestartEmpty }))
    rerenderWith(makeLocalStatus({ serverId: 'srv-2', serverName: 'Second' }))
    // Busy: not closed underneath the running apply.
    expect(onOpenChange).not.toHaveBeenCalled()
    resolveApply(makePlan({ applied: true }))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: en.toast.lifecycleSkipped.replace('{{server}}', 'Main Server') }),
      ),
    )
    expect(restart).not.toHaveBeenCalled()
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: en.toast.switchedToWorkshop.replace('{{server}}', 'Main Server') }),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('BridgeDeliverySwitchDialog: guided access', () => {
  it('shows the manual steps and records the choice with "I\'ve made these changes"', async () => {
    planDelivery.mockResolvedValue(
      makePlan({
        access: 'guided',
        steps: [{ kind: 'recordMethod', method: 'workshop', servers: ['Main Server'] }],
        manual: {
          modsEntry: 'ZomboidControlPanelBridge',
          workshopItemsEntry: WORKSHOP_ID,
          removeFiles: ['media/lua/server/PanelBridge.lua', 'media/lua/client/PanelBridgeClient.lua'],
          setChecksumFalse: false,
        },
      }),
    )
    renderDialog(makeLocalStatus({ access: 'guided', disk: null, serverRunning: null }))
    const steps = await screen.findByTestId('bridge-guided-steps')
    expect(within(steps).getAllByRole('listitem')).toHaveLength(5)
    expect(within(steps).getByRole('button', { name: `Copy ;${WORKSHOP_ID}` })).toBeInTheDocument()
    expect(screen.queryByTestId('bridge-delivery-steps')).toBeNull()
    expect(screen.queryByRole('button', { name: en.dialog.applyOnly })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.guided.done }))
    await waitFor(() =>
      expect(applyDelivery).toHaveBeenCalledWith({ serverId: 'srv-1', method: 'workshop', expectedFrom: 'local' }),
    )
  })

  // The dry run re-plans on fresh data, so a status that said "available"
  // can still come back blocked (-nosteam turned on meanwhile, the release
  // became invalid). Guided steps are done by hand: showing them here would
  // let the operator get around the block and add entries every join then
  // fails on.
  it.each([
    ['noSteam', WORKSHOP_ID],
    ['notPublished', null],
  ] as const)('a blocked guided plan (%s) shows only the block reason, never the manual steps', async (reason, workshopItemsEntry) => {
    planDelivery.mockResolvedValue(
      makePlan({
        access: 'guided',
        blocked: { reason },
        steps: [],
        manual: {
          modsEntry: 'ZomboidControlPanelBridge',
          workshopItemsEntry,
          removeFiles: ['media/lua/server/PanelBridge.lua', 'media/lua/client/PanelBridgeClient.lua'],
          setChecksumFalse: false,
        },
      }),
    )
    renderDialog(makeLocalStatus({ access: 'guided', disk: null, serverRunning: null }))
    expect((await screen.findAllByText(en.unavailable[reason])).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('bridge-guided-steps')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy ;ZomboidControlPanelBridge' })).toBeNull()
    expect(screen.queryByText(en.guided.title)).toBeNull()
    expect(screen.getByRole('button', { name: en.guided.done })).toBeDisabled()
  })

  it('switching a guided server back lists the reverse steps', async () => {
    planDelivery.mockResolvedValue(
      makePlan({
        from: 'workshop',
        to: 'local',
        access: 'guided',
        steps: [{ kind: 'recordMethod', method: 'local', servers: ['Main Server'] }],
        manual: { modsEntry: 'ZomboidControlPanelBridge', workshopItemsEntry: WORKSHOP_ID, removeFiles: [], setChecksumFalse: true },
      }),
    )
    renderDialog(makeWorkshopStatus({ access: 'guided', disk: null }), { to: 'local' })
    const steps = await screen.findByTestId('bridge-guided-steps')
    const items = within(steps).getAllByRole('listitem')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('In servertest.ini, remove these PanelBridge entries')
    expect(within(items[0]).getByRole('button', { name: 'Copy ZomboidControlPanelBridge' })).toBeInTheDocument()
    expect(items[2]).toHaveTextContent('Set DoLuaChecksum=false in servertest.ini.')
  })
})

describe('BridgeDeliverySwitchDialog: permissions', () => {
  it('without bridge.setup every apply button is disabled and explains why', async () => {
    mockCan = (capability) => capability !== 'bridge.setup'
    planDelivery.mockResolvedValue(makePlan())
    renderDialog(makeLocalStatus())
    await stepsList()
    const later = screen.getByRole('button', { name: en.dialog.applyOnly })
    expect(later).toBeDisabled()
    expect(screen.getByRole('button', { name: en.dialog.applyRestartEmpty })).toBeDisabled()
    fireEvent.focus(later.parentElement!)
    expect((await screen.findAllByText(enSettings.permissions.noBridgeSetup)).length).toBeGreaterThan(0)
    fireEvent.click(later)
    expect(applyDelivery).not.toHaveBeenCalled()
  })

  it('without server.control only "restart later" stays available', async () => {
    mockCan = (capability) => capability !== 'server.control'
    planDelivery.mockResolvedValue(makePlan())
    renderDialog(makeLocalStatus())
    await stepsList()
    expect(screen.getByRole('button', { name: en.dialog.applyOnly })).toBeEnabled()
    const restartButton = screen.getByRole('button', { name: en.dialog.applyRestartEmpty })
    expect(restartButton).toBeDisabled()
    fireEvent.focus(restartButton.parentElement!)
    expect((await screen.findAllByText(en.needsServerControl)).length).toBeGreaterThan(0)
  })
})

