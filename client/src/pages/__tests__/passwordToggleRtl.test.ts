import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The show/hide-password and clear-search buttons sat on the input with
// `absolute right-*` while the input reserved room for them with the logical
// `pe-*`. In a right-to-left language (Arabic) the room is on the left, so the
// button landed on top of the text. They use `end-*` now, like the shared
// PasswordInput.
const PAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PHYSICAL_RIGHT_OFFSET_RE = /\babsolute\s+-?right-/

describe.each(['Setup.tsx', 'Settings.tsx', 'ServerSetup.tsx'])('%s: overlay buttons follow the reading direction', (file) => {
  it('positions no absolute element by a physical right offset', () => {
    const offenders = fs
      .readFileSync(path.join(PAGES_DIR, file), 'utf8')
      .split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text: text.trim() }))
      .filter(({ text }) => PHYSICAL_RIGHT_OFFSET_RE.test(text))
    expect(offenders, `use end-* instead of right-* (RTL): ${JSON.stringify(offenders)}`).toEqual([])
  })
})
