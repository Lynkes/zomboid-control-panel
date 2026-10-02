import { describe, expect, it } from 'vitest'
// Not './localeModules': vite.config.ts's test alias rewrites only that exact
// specifier, so this import gets the import.meta.glob the app ships.
import { localeModules as bundled } from '@/i18n/localeModules'
import { localeModules as fromDisk } from './localeModules.fromDisk'

// Every other test loads the locales through localeModules.fromDisk.ts, so
// without this one a narrowed or broken glob in ../localeModules.ts would
// ship an app with missing translations while the whole suite stayed green.
// fromDisk lists every <code>/<namespace>.json under client/src/locales.
describe('localeModules', () => {
  it('bundles every locale file on disk, with the same contents the tests read', () => {
    expect(Object.keys(bundled).sort()).toEqual(Object.keys(fromDisk).sort())
    expect(bundled).toEqual(fromDisk)
  })
})
