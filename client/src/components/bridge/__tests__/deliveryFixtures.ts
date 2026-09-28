import type { DeliveryPlanResponse, DeliveryStatus } from '@/lib/bridgeDeliveryTypes'

// Contract-shaped mocks of GET/POST /api/panel-bridge/delivery (spec §5.3-5.4),
// built from lib/bridgeDeliveryTypes.ts so a contract change breaks these at
// the type level instead of silently drifting from the server's real shape.

export const WORKSHOP_ID = '3712345678'

export function makeLocalStatus(overrides: Partial<DeliveryStatus> = {}): DeliveryStatus {
  return {
    serverId: 'srv-1',
    serverName: 'Main Server',
    method: 'local',
    ownMethod: 'local',
    state: 'local-ok',
    access: 'automatic',
    hostOs: 'windows',
    sharedWith: [],
    switch: null,
    release: {
      status: 'published',
      source: 'file',
      modId: 'ZomboidControlPanelBridge',
      workshopId: WORKSHOP_ID,
      visibility: 'unlisted',
      publishedVersion: '1.7.71',
      publishedAt: '2026-10-01T00:00:00.000Z',
      preview: false,
      linuxChecksumVerified: false,
    },
    effectiveWorkshopId: WORKSHOP_ID,
    switchAvailability: {
      toWorkshop: { available: true, reason: null, warnings: [] },
      toLocal: { available: false, reason: 'sameMethod', warnings: [] },
    },
    serverRunning: true,
    restartedSinceSwitch: null,
    live: { alive: true, version: '1.7.70', delivery: 'loose', workshopId: null, startedAt: 1759000000000, gameVersion: '42.20.0' },
    disk: {
      installDir: 'D:\\PZServer',
      looseFiles: [{ path: 'media/lua/server/PanelBridge.lua', kind: 'server', recognized: true }],
      iniPath: 'C:\\Users\\op\\Zomboid\\Server\\servertest.ini',
      iniEntries: { mods: false, workshopItems: false },
      workshopItem: null,
    },
    lastStartFailure: null,
    steamReportsUnavailable: false,
    modAutoRestart: false,
    bundledVersion: '1.7.70',
    checksum: { current: false, canTurnOn: false, turnOnBlockers: ['notWorkshop'], playersBlocked: false, requiresLinuxAck: false },
    ...overrides,
  }
}

export function makeWorkshopStatus(overrides: Partial<DeliveryStatus> = {}): DeliveryStatus {
  return makeLocalStatus({
    method: 'workshop',
    ownMethod: 'workshop',
    state: 'workshop-confirmed',
    switch: {
      to: 'workshop',
      at: '2026-10-02T10:00:00.000Z',
      by: 'admin',
      bridgeStartedAt: 1759000000000,
      workshopId: WORKSHOP_ID,
    },
    switchAvailability: {
      toWorkshop: { available: false, reason: 'sameMethod', warnings: [] },
      toLocal: { available: true, reason: null, warnings: [] },
    },
    restartedSinceSwitch: true,
    live: { alive: true, version: '1.7.71', delivery: 'workshop', workshopId: WORKSHOP_ID, startedAt: 1759000999000, gameVersion: '42.20.0' },
    disk: {
      installDir: 'D:\\PZServer',
      looseFiles: [],
      iniPath: 'C:\\Users\\op\\Zomboid\\Server\\servertest.ini',
      iniEntries: { mods: true, workshopItems: true },
      workshopItem: { folder: `D:\\PZServer\\steamapps\\workshop\\content\\108600\\${WORKSHOP_ID}`, version: '1.7.71', source: 'candidate' },
    },
    checksum: { current: false, canTurnOn: true, turnOnBlockers: [], playersBlocked: false, requiresLinuxAck: false },
    ...overrides,
  })
}

export function makePlan(overrides: Partial<DeliveryPlanResponse> = {}): DeliveryPlanResponse {
  return {
    serverId: 'srv-1',
    from: 'local',
    to: 'workshop',
    access: 'automatic',
    blocked: null,
    steps: [
      { kind: 'iniAdd', key: 'Mods', value: 'ZomboidControlPanelBridge', file: 'C:\\Users\\op\\Zomboid\\Server\\servertest.ini', serverName: 'Main Server' },
      { kind: 'iniAdd', key: 'WorkshopItems', value: WORKSHOP_ID, file: 'C:\\Users\\op\\Zomboid\\Server\\servertest.ini', serverName: 'Main Server' },
      { kind: 'archiveFile', file: 'D:\\PZServer\\media\\lua\\server\\PanelBridge.lua', fileKind: 'server', recognized: true },
      { kind: 'recordMethod', method: 'workshop', servers: ['Main Server'] },
    ],
    warnings: [],
    sharedWith: [],
    manual: null,
    applied: false,
    restartRequired: true,
    backups: [],
    status: makeLocalStatus(),
    ...overrides,
  }
}
