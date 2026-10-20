import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { LANGUAGES } from '@/i18n/languages'
import {
  NAV_SECTIONS,
  ROUTES,
  ROUTE_ALIASES,
  getActiveSidebarRoute,
  getRouteMeta,
  routeAvailability,
  useRouteMeta,
} from '../navigation'

// The route registry (UX plan §2.3) is the one place a page's name, icon,
// gates, shortcut and loader live. These pin the contract the sidebar,
// palette, shortcuts, loader and headers read from it.

const resolves = (lng: string, key: string) => {
  const [ns, path] = key.split(':')
  return typeof i18n.getResource(lng, ns, path) === 'string'
}

describe('ROUTES / NAV_SECTIONS', () => {
  it('has one entry per path', () => {
    const paths = ROUTES.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('builds the sidebar as SERVER / PLAYERS / WORLD / PANEL in the planned order', () => {
    expect(NAV_SECTIONS.map((section) => [section.id, section.accent])).toEqual([
      ['server', 'primary'],
      ['players', 'success'],
      ['world', 'warning'],
      ['panel', 'muted'],
    ])
    expect(NAV_SECTIONS.map((section) => section.paths)).toEqual([
      ['/console', '/server-config', '/mods', '/files', '/templates', '/scheduler'],
      ['/players', '/chat', '/leaderboard'],
      ['/world-map', '/events', '/backups', '/chunks'],
      ['/servers', '/discord', '/settings', '/debug', '/server-finder'],
    ])
  })

  it('keeps Add a Server out of the sidebar, lit through Servers', () => {
    expect(getRouteMeta('/server-setup')?.inSidebar).toBe(false)
    expect(getActiveSidebarRoute('/server-setup')?.path).toBe('/servers')
  })

  it('maps the digit shortcuts 1-9 to the same pages as before', () => {
    const shortcuts = Object.fromEntries(ROUTES.filter((r) => r.shortcut).map((r) => [r.shortcut, r.path]))
    expect(shortcuts).toEqual({
      1: '/', 2: '/console', 3: '/players', 4: '/chat', 5: '/events', 6: '/mods', 7: '/backups', 8: '/server-config', 9: '/settings',
    })
  })

  it('keeps every gate the old sidebar had', () => {
    const gates = (path: string) => {
      const r = getRouteMeta(path)!
      return { capability: r.capability, requiresServer: !!r.requiresServer, requiresLocal: !!r.requiresLocal, mirror: !!r.allowRemoteConfigMirror }
    }
    expect(gates('/files')).toEqual({ capability: 'files.manage', requiresServer: true, requiresLocal: false, mirror: false })
    expect(gates('/server-config')).toEqual({ capability: undefined, requiresServer: true, requiresLocal: true, mirror: true })
    expect(gates('/templates')).toEqual({ capability: undefined, requiresServer: true, requiresLocal: true, mirror: true })
    for (const path of ['/mods', '/backups', '/chunks']) expect(gates(path)).toMatchObject({ requiresServer: true, requiresLocal: true, mirror: false })
    for (const path of ['/console', '/scheduler', '/players', '/chat', '/leaderboard', '/world-map', '/events']) {
      expect(gates(path)).toMatchObject({ requiresServer: true, requiresLocal: false })
    }
    for (const path of ['/', '/servers', '/discord', '/settings', '/debug', '/server-finder', '/server-setup']) {
      expect(gates(path)).toMatchObject({ requiresServer: false, requiresLocal: false })
    }
  })

  it('gives every page a module to load', () => {
    for (const route of ROUTES) expect(typeof route.load).toBe('function')
  })
})

describe('translation keys', () => {
  const keys = ROUTES.flatMap((route) => [
    route.labelKey,
    route.titleKey,
    route.loader.descriptionKey,
    ...(route.deepLinks?.items.map((item) => item.labelKey) ?? []),
  ]).concat(NAV_SECTIONS.map((section) => section.labelKey))

  it.each(LANGUAGES.map((l) => l.code))('%s has every label, title, loader description and section name', (lng) => {
    const missing = keys.filter((key) => !resolves(lng, key))
    expect(missing).toEqual([])
  })
})

describe('getRouteMeta / useRouteMeta', () => {
  it('resolves old aliases and a trailing slash', () => {
    for (const [from, to] of Object.entries(ROUTE_ALIASES)) expect(getRouteMeta(from)?.path).toBe(to)
    expect(getRouteMeta('/mods/')?.path).toBe('/mods')
    expect(getRouteMeta('/nope')).toBeUndefined()
  })

  it('reads the current location inside a router, and is undefined outside one', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(MemoryRouter, { initialEntries: ['/chunks'] }, children)
    expect(renderHook(() => useRouteMeta(), { wrapper }).result.current?.titleKey).toBe('chunkCleaner:pageHeader.title')
    expect(renderHook(() => useRouteMeta()).result.current).toBeUndefined()
    expect(renderHook(() => useRouteMeta('/events')).result.current?.section).toBe('world')
  })
})

describe('routeAvailability', () => {
  const route = (path: string) => getRouteMeta(path)!
  const ctx = { can: () => true, serversConfirmedEmpty: false, activeServer: { isRemote: false } }

  it('hides a page the role lacks the capability for', () => {
    expect(routeAvailability(route('/files'), { ...ctx, can: (c) => c !== 'files.manage' })).toEqual({ state: 'hidden' })
  })

  it('disables a server page, with the reason, only once the server list is confirmed empty', () => {
    expect(routeAvailability(route('/console'), { ...ctx, serversConfirmedEmpty: true }))
      .toEqual({ state: 'disabled', reasonKey: 'shell:nav.requiresServer' })
    expect(routeAvailability(route('/servers'), { ...ctx, serversConfirmedEmpty: true })).toEqual({ state: 'enabled' })
  })

  it('disables a local-only page for a remote server, unless its config mirror allows it', () => {
    const remote = { ...ctx, activeServer: { isRemote: true } }
    expect(routeAvailability(route('/mods'), remote)).toEqual({ state: 'disabled', reasonKey: 'shell:nav.notAvailableRemote' })
    expect(routeAvailability(route('/server-config'), remote).state).toBe('disabled')
    expect(routeAvailability(route('/server-config'), { ...ctx, activeServer: { isRemote: true, remoteConfigConfigured: true } }).state).toBe('enabled')
    expect(routeAvailability(route('/files'), remote).state).toBe('enabled')
  })
})
