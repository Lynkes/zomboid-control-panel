import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Tailwind 3 only knows the opacity steps of its scale (0, 5, 10 ... 100):
// a colour with any other step (bg-background/78, hover:bg-primary/92,
// border-warning/24) compiles to nothing. That left every confirmation
// dialog's backdrop undimmed, the primary button without a hover state and
// the sidebar's connection notice without its tinted border. DESIGN.md
// says so; this keeps the shared kit and the shell to it.

const SRC = path.resolve(process.cwd(), 'src')
const SCALE = new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100])
const COLOUR_UTILITY =
  /(?<![\w/[-])(?:[\w-]+:)*(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|from|via|to|fill|stroke|shadow|outline|decoration|divide|placeholder|caret|accent)-[a-z]+(?:-[a-z0-9]+)*\/(\d+)\b/g

function filesToCheck(): string[] {
  const kit = fs
    .readdirSync(path.join(SRC, 'components/ui'))
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => `components/ui/${file}`)
  const shell = [
    'App.tsx',
    'components/Layout.tsx',
    'components/ConnectionStatus.tsx',
    'components/CommandPalette.tsx',
    'components/PageHeader.tsx',
    'components/PageAlerts.tsx',
    'components/PageSkeleton.tsx',
    'components/SaveBar.tsx',
    'components/AuthScreenLayout.tsx',
    'components/KeyboardShortcutsHelp.tsx',
  ]
  return [...kit, ...shell]
}

describe('Tailwind opacity steps in the shared kit and the shell', () => {
  it('uses only steps on Tailwind\'s scale', () => {
    const offScale: string[] = []
    for (const file of filesToCheck()) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8')
      for (const match of source.matchAll(COLOUR_UTILITY)) {
        if (!SCALE.has(Number(match[1]))) offScale.push(`${file}: ${match[0]}`)
      }
    }
    expect(offScale).toEqual([])
  })

  it('would catch an off-scale step (the pattern itself)', () => {
    const sample = '"fixed inset-0 bg-background/78 hover:bg-primary/92 border-warning/24 w-1/2 bg-[hsl(var(--x)/0.12)] bg-primary/90"'
    const found = [...sample.matchAll(COLOUR_UTILITY)].filter((m) => !SCALE.has(Number(m[1]))).map((m) => m[0])
    expect(found).toEqual(['bg-background/78', 'hover:bg-primary/92', 'border-warning/24'])
  })
})
