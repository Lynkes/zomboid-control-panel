// Name and path rules for Server Files (spec §A4.2), mirrored exactly from
// validateSegments()/validateName() in server/services/fileManagerContract.js.
// Both sides are tested against server/tests/fixtures/fileManagerNameCases.json
// (nameRules.test.ts here), so the dialogs refuse a name with the same reason
// the server would, before the request is sent. The server stays the only
// enforcement; this is feedback while typing.
//
// The checks run in the table's order, so a name that breaks several rules
// always reports the same reason on both sides.
import { FM_LIMITS, type NameRuleReason } from '@/types/files'

const TRASH_DIR_NAME = '.zcp-trash'
const UPLOAD_TEMP_SUFFIX = '.zcpupload'
const RENAME_TEMP_SUFFIX = '.zcptmp'

// Windows device names, matched on the part before the first dot with
// trailing spaces removed ("con.txt", "NUL .log" and "Com1.tar.gz" all count).
const RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$)$/i
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const CONTROL_RE = /[\u0000-\u001F\u007F]/
const WINDOWS_RESERVED_RE = /[<>"|?*]/
const BIDI_CONTROL_RE = /[‎‏‪-‮⁦-⁩]/

// UTF-8 length, the way TextEncoder counts it (a lone surrogate becomes
// U+FFFD, three bytes), without allocating.
function utf8ByteLength(str: string): number {
  let bytes = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else bytes += 3
  }
  return bytes
}

function segmentReason(seg: string): NameRuleReason | null {
  if (utf8ByteLength(seg) > FM_LIMITS.SEGMENT_MAX_BYTES) return 'tooLong'
  if (seg === '.' || seg === '..') return 'dotSegment'
  if (CONTROL_RE.test(seg)) return 'control'
  if (seg.includes('\\')) return 'backslash'
  if (seg.includes(':')) return 'colon'
  if (WINDOWS_RESERVED_RE.test(seg)) return 'windowsReserved'
  if (RESERVED_DEVICE_NAME_RE.test(seg.split('.')[0].replace(/ +$/, ''))) return 'reservedDeviceName'
  if (seg.endsWith('.') || seg.endsWith(' ')) return 'trailingDotOrSpace'
  if (BIDI_CONTROL_RE.test(seg)) return 'bidiControl'
  return null
}

export type SegmentsResult = { ok: true; segments: string[] } | { ok: false; reason: NameRuleReason }
export type NameResult = { ok: true; name: string } | { ok: false; reason: NameRuleReason }

/**
 * A request `path`: POSIX segments joined by "/", "" meaning the root. No
 * decoding happens, so a literal "%2e%2e" is an ordinary name.
 */
export function validateSegments(raw: unknown): SegmentsResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  if (raw === '') return { ok: true, segments: [] }
  // Before any regex runs.
  if (raw.length > FM_LIMITS.REL_PATH_MAX_CHARS) return { ok: false, reason: 'tooLong' }
  const segments = raw.split('/')
  // "a//b", a leading "/" and a trailing "/" all leave an empty segment.
  if (segments.some((seg) => seg === '')) return { ok: false, reason: 'empty' }
  if (segments.length > FM_LIMITS.PATH_DEPTH_MAX) return { ok: false, reason: 'tooLong' }
  for (const seg of segments) {
    const reason = segmentReason(seg)
    if (reason) return { ok: false, reason }
  }
  return { ok: true, segments }
}

/**
 * A single `name` field (new file or folder, rename, duplicate, restore-as,
 * an uploaded file's name). `isNew` adds the rules that only apply to a name
 * the panel is about to create.
 */
export function validateName(name: unknown, { isNew = false }: { isNew?: boolean } = {}): NameResult {
  if (typeof name !== 'string' || name === '') return { ok: false, reason: 'empty' }
  // Before any regex runs.
  if (name.length > FM_LIMITS.REL_PATH_MAX_CHARS) return { ok: false, reason: 'tooLong' }
  const reason = segmentReason(name)
  if (reason) return { ok: false, reason }
  if (isNew) {
    if (name.startsWith(' ')) return { ok: false, reason: 'leadingSpace' }
    const lower = name.toLowerCase()
    if (lower === TRASH_DIR_NAME || lower.endsWith(UPLOAD_TEMP_SUFFIX) || lower.endsWith(RENAME_TEMP_SUFFIX)) {
      return { ok: false, reason: 'reservedPanelName' }
    }
  }
  if (name.includes('/')) return { ok: false, reason: 'slash' }
  return { ok: true, name }
}
