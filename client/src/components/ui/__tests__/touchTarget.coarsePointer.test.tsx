import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import postcss, { type Declaration, type Rule } from 'postcss'
import tailwindcss from 'tailwindcss'
import { Switch } from '../switch'
import { Checkbox } from '../checkbox'

// 2026-10-08: on touch devices every Switch rendered as a 44px circle with
// the thumb in the middle (seen on the Scheduler's task rows at 375px), and
// every Checkbox as a 44px square. index.css's coarse-pointer rule gives bare
// <button>s a 44x44 minimum, and Radix renders both as <button role=...>.
// The rule now skips them and the components carry their own invisible 44px
// hit area. jsdom does no layout and ignores pointer media queries, so these
// pin the selector and the compiled classes; the result was measured in the
// demo client at 375px with touch emulation.

function coarsePointerTargetRule(): Rule {
  const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8')
  let found: Rule | undefined
  postcss.parse(css).walkAtRules('media', (media) => {
    if (!/pointer:\s*coarse/.test(media.params)) return
    media.walkRules((rule) => {
      if (rule.some((node) => node.type === 'decl' && node.prop === 'min-width' && node.value === '44px')) {
        found = rule
      }
    })
  })
  if (!found) throw new Error('no 44px min-width rule under @media (pointer: coarse) in index.css')
  return found
}

describe('coarse-pointer 44px rule (index.css)', () => {
  it('still covers plain buttons and labelled links, but skips switches and checkboxes', () => {
    const { selector } = coarsePointerTargetRule()
    render(
      <>
        <button type="button">Help</button>
        <a href="#github" aria-label="GitHub">gh</a>
        <Switch aria-label="Enabled" />
        <Checkbox aria-label="Select" />
      </>,
    )

    expect(screen.getByRole('button', { name: 'Help' }).matches(selector)).toBe(true)
    expect(screen.getByRole('link', { name: 'GitHub' }).matches(selector)).toBe(true)
    expect(screen.getByRole('switch').matches(selector)).toBe(false)
    expect(screen.getByRole('checkbox').matches(selector)).toBe(false)
  })

  it('stays as weak as a bare `button` selector, so utilities like min-w-0 still override it', () => {
    const buttonPart = coarsePointerTargetRule().selectors.find((part) => part.startsWith('button'))
    // Only a :where() exclusion (zero specificity) may be added to `button`.
    expect(buttonPart?.replace(/:not\(:where\([^()]*\)\)/g, '')).toBe('button')
  })
})

describe('Switch and Checkbox touch hit area', () => {
  it('compiles an invisible, centred ::before of at least 44x44 that only exists on coarse pointers', async () => {
    render(
      <>
        <Switch aria-label="Enabled" />
        <Checkbox aria-label="Select" />
      </>,
    )
    const controls = [screen.getByRole('switch'), screen.getByRole('checkbox')]
    for (const control of controls) {
      // The ::before is positioned against the control, not some ancestor.
      expect(control.className.split(' ')).toContain('relative')
    }

    const { css } = await postcss([
      tailwindcss({
        content: [{ raw: controls.map((control) => control.className).join(' ') }],
        corePlugins: { preflight: false },
      }),
    ]).process('@tailwind utilities;', { from: undefined })

    const coarse: Record<string, string> = {}
    const coarseSelectors: string[] = []
    const fineBeforeSelectors: string[] = []
    postcss.parse(css).walkRules((rule) => {
      const media = rule.parent?.type === 'atrule' ? rule.parent : undefined
      const isCoarse = media !== undefined && 'params' in media && /pointer:\s*coarse/.test(String(media.params))
      if (isCoarse) {
        coarseSelectors.push(rule.selector)
        rule.walkDecls((decl: Declaration) => {
          coarse[decl.prop] = decl.value
        })
      } else if (rule.selector.includes('::before')) {
        fineBeforeSelectors.push(rule.selector)
      }
    })

    // Everything in the coarse block targets the pseudo-element: the control
    // itself keeps its pill/box size and layout footprint.
    expect(coarseSelectors.length).toBeGreaterThan(0)
    expect(coarseSelectors.every((selector) => selector.endsWith('::before'))).toBe(true)
    expect(fineBeforeSelectors).toEqual([])
    expect(coarse).toMatchObject({
      content: 'var(--tw-content)',
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '100%',
      height: '100%',
      'min-width': '2.75rem',
      'min-height': '2.75rem',
      '--tw-translate-x': '-50%',
      '--tw-translate-y': '-50%',
    })
  })
})
