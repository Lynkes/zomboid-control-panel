import { describe, it, expect } from 'vitest'
import { isValidInstallPort } from '../ServerSetup'

// conv-hunt-pages-2 lens 4b, previously deferred: server/routes/server.js's
// /install, /quick-setup, /configure-rcon and /configure-network used to
// silently coerce an out-of-range rconPort/serverPort to a default (via the
// old validateInt()) rather than reject -- so there was no server rejection
// to route around, and this page was set aside twice for that reason.
// Kevin's 39f836f (requireIntInRange, server.js:1741/1745/2244/2248/2422/2500)
// closed that gap: those four endpoints now return a 400 naming the field and
// its range (1024-65535) instead of silently substituting a default. That
// makes the premise for deferring ServerSetup.tsx false -- the four
// install/quick-setup port fields (rconPort, serverPort) were always bare
// `parseInt(e.target.value) || default` with no clamp, same shape already
// fixed on Servers.tsx/Settings.tsx/Players.tsx.
describe('ServerSetup -- isValidInstallPort', () => {
  it('rejects ports outside 1024-65535, matching requireIntInRange on the server', () => {
    expect(isValidInstallPort(0)).toBe(false)
    expect(isValidInstallPort(1023)).toBe(false)
    expect(isValidInstallPort(80)).toBe(false)
    expect(isValidInstallPort(65536)).toBe(false)
    expect(isValidInstallPort(NaN)).toBe(false)
  })

  it('accepts ports within 1024-65535', () => {
    expect(isValidInstallPort(1024)).toBe(true)
    expect(isValidInstallPort(27015)).toBe(true)
    expect(isValidInstallPort(65535)).toBe(true)
  })
})
