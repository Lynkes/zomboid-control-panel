import { describe, expect, it } from 'vitest'
import { resolveRestartOrigin, servedPort, type PanelPageLocation } from '../panelRestartTarget'

function page(url: string): PanelPageLocation {
  const parsed = new URL(url)
  return { protocol: parsed.protocol, hostname: parsed.hostname, host: parsed.host, port: parsed.port }
}

describe('servedPort', () => {
  it('reads the port from the address bar', () => {
    expect(servedPort(page('http://192.168.1.5:3001/settings'))).toBe(3001)
  })

  it('falls back to the protocol default when the address has no port', () => {
    expect(servedPort(page('https://panel.example.com/'))).toBe(443)
    expect(servedPort(page('http://panel.example.com/'))).toBe(80)
  })
})

describe('resolveRestartOrigin', () => {
  it('stays on the page origin when the saved port is the port the page is on', () => {
    expect(resolveRestartOrigin(page('http://192.168.1.5:3001/settings'), '3001', 3001)).toBe('http://192.168.1.5:3001')
  })

  it('moves to the saved port when the port really changed and the page is on the running port', () => {
    expect(resolveRestartOrigin(page('http://192.168.1.5:3001/settings'), '3002', 3001)).toBe('http://192.168.1.5:3002')
    expect(resolveRestartOrigin(page('http://[::1]:3001/'), '3002', 3001)).toBe('http://[::1]:3002')
  })

  it('also moves after the change was saved earlier and Settings was reopened before restarting', () => {
    // Settings now shows 3002 (saved), the process still runs on 3001.
    expect(resolveRestartOrigin(page('http://localhost:3001/'), 3002, 3001)).toBe('http://localhost:3002')
  })

  it('stays on the page origin behind a reverse proxy, whatever the saved port is', () => {
    expect(resolveRestartOrigin(page('https://panel.example.com/settings?tab=general'), '3001', 3001)).toBe('https://panel.example.com')
    // A port change saved behind the proxy: the proxy still fronts the panel.
    expect(resolveRestartOrigin(page('https://panel.example.com/'), '3002', 3001)).toBe('https://panel.example.com')
  })

  it('stays on the page origin when Docker publishes the panel under another port', () => {
    expect(resolveRestartOrigin(page('http://nas.local:8080/'), '3001', 3001)).toBe('http://nas.local:8080')
  })

  it('stays on the page origin on the HTTPS listener', () => {
    expect(resolveRestartOrigin(page('https://192.168.1.5:3443/'), '3001', 3001)).toBe('https://192.168.1.5:3443')
    expect(resolveRestartOrigin(page('https://192.168.1.5:3443/'), '3002', 3001)).toBe('https://192.168.1.5:3443')
  })

  it('stays on the page origin when the running port is unknown or the saved one is not a port', () => {
    expect(resolveRestartOrigin(page('http://192.168.1.5:3001/'), '3002', null)).toBe('http://192.168.1.5:3001')
    expect(resolveRestartOrigin(page('http://192.168.1.5:3001/'), '3002', undefined)).toBe('http://192.168.1.5:3001')
    expect(resolveRestartOrigin(page('http://192.168.1.5:3001/'), '', 3001)).toBe('http://192.168.1.5:3001')
    expect(resolveRestartOrigin(page('http://192.168.1.5:3001/'), 'abc', 3001)).toBe('http://192.168.1.5:3001')
    expect(resolveRestartOrigin(page('http://192.168.1.5:3001/'), '70000', 3001)).toBe('http://192.168.1.5:3001')
  })
})
