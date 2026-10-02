import fs from 'node:fs'
import path from 'node:path'

// What ../localeModules.ts gives the app, read from disk instead; the
// client's vite.config.ts aliases it in for tests only. test-setup.ts loads
// i18n into every test file, and through Vite that meant 620 locale modules
// (11 MB) transformed in the main process and sent to the worker, again for
// each of the 400+ files: about 2 seconds of setup per file, more than most
// tests take to run. Reading and parsing the same files here takes tens of
// milliseconds.
//
// Same keys as import.meta.glob('../locales/*/*.json'): one level of
// folders under locales/, *.json files only. The folder comes from
// vite.config.ts's test.env (import.meta.url isn't a file URL under jsdom).
const localesDir = process.env.ZCP_LOCALES_DIR
if (!localesDir) {
  throw new Error('ZCP_LOCALES_DIR is not set; it comes from test.env in client/vite.config.ts')
}

const modules: Record<string, any> = {}
for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const folder = path.join(localesDir, entry.name)
  for (const file of fs.readdirSync(folder)) {
    if (!file.endsWith('.json')) continue
    modules[`../locales/${entry.name}/${file}`] = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'))
  }
}

export const localeModules = modules
