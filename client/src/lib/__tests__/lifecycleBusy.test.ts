import { describe, expect, it } from 'vitest'
import { ApiError, type LifecycleHolder, type LifecycleState } from '../api'
import { lifecycleBlocker, lifecycleBusyFromError, lifecycleBusyReason } from '../lifecycleBusy'
import { getUserErrorMessage } from '../errorMessage'

// Why a Start/Stop/Restart is unavailable, following the server's rules: the
// panel-wide lock refuses every server, a server waiting for its RCON only
// itself (and switching the active server), and Stop cancels a restart of
// the same server instead of being refused by it.

function holder(extra: Partial<LifecycleHolder>): LifecycleHolder {
  return { operation: 'start', serverId: null, serverName: null, phase: null, since: 1, ...extra }
}

const waitingAlive: LifecycleState = {
  lock: null,
  servers: [holder({ operation: 'start', serverId: 'alive', serverName: 'LNKAlive', phase: 'waiting-for-rcon' })],
}

describe('lifecycleBusyReason()', () => {
  it('refuses only the server that waits for its RCON', () => {
    expect(lifecycleBusyReason(waitingAlive, 'alive', 'stop')).toBe('LNKAlive is starting: waiting for its RCON to answer.')
    expect(lifecycleBusyReason(waitingAlive, 'outbreak', 'start')).toBeNull()
    expect(lifecycleBusyReason(waitingAlive, 'outbreak', 'stop')).toBeNull()
  })

  it('keeps switching the active server refused while any server waits for its RCON', () => {
    expect(lifecycleBusyReason(waitingAlive, 'outbreak', 'switch')).toBe('LNKAlive is starting: waiting for its RCON to answer.')
  })

  it('runs restarts one at a time', () => {
    const restarting: LifecycleState = {
      lock: null,
      servers: [holder({ operation: 'restart', serverId: 'alive', serverName: 'LNKAlive', phase: 'waiting-for-rcon' })],
    }
    expect(lifecycleBusyReason(restarting, 'outbreak', 'restart')).toBe('LNKAlive is starting: waiting for its RCON to answer.')
    expect(lifecycleBusyReason(restarting, 'outbreak', 'start')).toBeNull()
    expect(lifecycleBusyReason(waitingAlive, 'outbreak', 'restart')).toBeNull()
  })

  it('names the panel-wide lock for every server', () => {
    const stopping: LifecycleState = {
      lock: holder({ operation: 'stop', serverId: 'outbreak', serverName: 'LNK-OUTBREAK' }),
      servers: [],
    }
    expect(lifecycleBusyReason(stopping, 'alive', 'start')).toBe('Stop of LNK-OUTBREAK in progress.')
    expect(lifecycleBusyReason(stopping, 'outbreak', 'restart')).toBe('Stop of LNK-OUTBREAK in progress.')
  })

  it('lets Stop and Force stop through a restart of the same server, which they cancel', () => {
    const restarting: LifecycleState = {
      lock: holder({ operation: 'restart', serverId: 'alive', serverName: 'LNKAlive' }),
      servers: [],
    }
    expect(lifecycleBlocker(restarting, 'alive', 'stop')).toBeNull()
    expect(lifecycleBlocker(restarting, 'alive', 'forceStop')).toBeNull()
    expect(lifecycleBusyReason(restarting, 'outbreak', 'stop')).toBe('Restart of LNKAlive in progress.')
  })

  it('words an operation with no server, and one it has no label for', () => {
    expect(lifecycleBusyReason({ lock: holder({ operation: 'automatic-update' }), servers: [] }, 'alive', 'start'))
      .toBe('Update in progress.')
    expect(lifecycleBusyReason({ lock: holder({ operation: 'test-probe' }), servers: [] }, 'alive', 'start'))
      .toBe('Another server operation in progress.')
  })

  it('treats nothing as busy before the state has loaded', () => {
    expect(lifecycleBusyReason(null, 'alive', 'start')).toBeNull()
  })
})

describe('the lifecycle refusal as an error', () => {
  const refusal = new ApiError("'LNKAlive' is starting: the panel is waiting for its RCON to answer", {
    status: 409,
    code: 'SERVER_LIFECYCLE_IN_PROGRESS',
    data: { holder: waitingAlive.servers[0] },
  })

  it('reads the holder the 409 carries, in the user\'s language', () => {
    expect(lifecycleBusyFromError(refusal)).toBe('LNKAlive is starting: waiting for its RCON to answer.')
    expect(getUserErrorMessage(refusal, 'fallback')).toBe('LNKAlive is starting: waiting for its RCON to answer.')
  })

  it('falls back to the server\'s message without a holder, and ignores any other error', () => {
    const bare = new ApiError('Another server lifecycle operation is already in progress', { status: 409, code: 'SERVER_LIFECYCLE_IN_PROGRESS' })
    expect(lifecycleBusyFromError(bare)).toBe('Another server lifecycle operation is already in progress')
    expect(lifecycleBusyFromError(new ApiError('nope', { status: 500, code: 'SOMETHING_ELSE' }))).toBeNull()
    expect(lifecycleBusyFromError(new Error('plain'))).toBeNull()
  })
})
