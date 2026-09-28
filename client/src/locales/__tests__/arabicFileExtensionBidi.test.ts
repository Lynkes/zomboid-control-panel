import { describe, expect, it } from 'vitest'

// In a right-to-left paragraph, a bare ".ini" after Arabic text (or after
// "(") shows as "ini.": the full stop is neutral, sits between an RTL run
// and a Latin one, and resolves right-to-left (Unicode bidi W6, then N2).
// Outside <code dir="ltr">, the Arabic copy puts a LEFT-TO-RIGHT MARK before
// the full stop, the same fix the bridge copy uses after a bare "Mods=".
const arabic = import.meta.glob('../ar/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

function strings(node: unknown, path: string, out: Array<[string, string]>) {
  if (typeof node === 'string') out.push([path, node])
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) strings(value, path ? `${path}.${key}` : key, out)
  }
  return out
}

describe('Arabic copy: bare file extensions stay left-to-right', () => {
  it('puts U+200E before every bare file extension (.ini, .lua, .txt, ...) that follows Arabic text or "("', () => {
    const offenders: string[] = []
    for (const [file, json] of Object.entries(arabic)) {
      for (const [key, value] of strings(json, '', [])) {
        const text = value.replace(/<code[^>]*>.*?<\/code>/g, '')
        if (/[\s(\u0600-\u06FF]\.(ini|lua|txt|log|json|zip|bat|sh)\b/.test(text)) offenders.push(`${file}: ${key}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
