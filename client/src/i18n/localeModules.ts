// Every client/src/locales/<code>/<namespace>.json, keyed by its path from
// this folder ("../locales/en/shell.json"), bundled into the app at build
// time. Tests get the same object from __tests__/localeModules.fromDisk.ts
// instead (vite.config.ts's test alias): see that file for why.
// __tests__/localeModules.test.ts checks this glob against it.
//
// i18next's own Resource type is this loose (ResourceKey = string | an
// object of unspecified shape), so `any` here matches its actual contract
// rather than fighting it with a narrower type that doesn't describe it.
export const localeModules = import.meta.glob('../locales/*/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, any>
