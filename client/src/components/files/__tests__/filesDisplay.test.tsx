import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { ApiError } from '@/lib/api'
import { isolateLtrForRtl } from '@/lib/paramTranslation'
import { DropOverlay } from '../DropOverlay'
import { RecentChanges } from '../RecentChanges'
import { commonFolder, describeFilesError, describeResultError, unavailableText } from '../filesUi'

// How the file manager words what the server sends: byte and count limits,
// the drop overlay's folder in a right-to-left language, the rows of
// "Recent file changes", and why an SFTP root can't be opened.

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await i18n.changeLanguage('en')
})

describe('limits in error messages', () => {
  it('a per-file upload check shows a readable size', () => {
    const text = describeResultError({ code: 'FM_UPLOAD_TOO_LARGE', params: { limit: 2147483648 } })
    expect(text).not.toContain('2147483648')
    expect(text).toContain('GB')
  })

  it('a refused download shows a readable size', () => {
    const error = new ApiError('x', { status: 413, code: 'FM_DOWNLOAD_TOO_LARGE', data: { code: 'FM_DOWNLOAD_TOO_LARGE', params: { limit: 4294967296 } } })
    const text = describeFilesError(error)
    expect(text).not.toContain('4294967296')
    expect(text).toContain('GB')
  })

  it('a count limit is a formatted number', () => {
    const error = new ApiError('x', { status: 413, code: 'FM_TOO_MANY_ENTRIES', data: { code: 'FM_TOO_MANY_ENTRIES', params: { limit: 100000 } } })
    expect(describeFilesError(error)).toContain('100,000')
  })

  it('a zip pre-check that ran out of time is not called "too large"', () => {
    const text = describeResultError({ code: 'FM_ZIP_TOO_LARGE', params: { reason: 'time' } })
    expect(text).toBe(i18n.t('download.zipTooSlow', { ns: 'files' }))
  })
})

describe('the drop overlay in Arabic', () => {
  it('shows the folder label as the page built it, not inside a second left-to-right isolate', async () => {
    await i18n.changeLanguage('ar')
    const rootLabel = i18n.t('roots.labels.data', { ns: 'files' })
    // Built the way Files.tsx builds folderLabel: only the path part is isolated.
    const folderLabel = `${rootLabel} / ${isolateLtrForRtl('Server')}`
    const { container } = render(<DropOverlay visible folder={folderLabel} />)
    const text = container.textContent ?? ''
    expect(text).toContain(folderLabel)
    expect(text).not.toContain(`⁦${folderLabel}⁩`)
  })
})

describe('Recent file changes', () => {
  function stubAudit() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      entries: [
        { id: 'a1', at: '2026-09-29T12:00:00.000Z', actor: { userId: 'u1', username: 'kate' }, op: 'files.delete.trash', profileId: 'p1', rootId: 'data', backend: 'local', paths: ['old.log'], result: 'ok' },
        { id: 'a2', at: '2026-09-29T12:01:00.000Z', actor: { userId: 'u2', username: 'bob' }, op: 'files.denied', profileId: 'p1', rootId: 'install', backend: 'local', paths: ['start-server.sh'], result: 'denied', code: 'FM_PATH_PROTECTED' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
  }

  it.each(['en', 'ar'])('rows read in the page language (%s), not as audit ids', async (lng) => {
    await i18n.changeLanguage(lng)
    stubAudit()
    render(<RecentChanges profileId="p1" refreshKey={0} />)
    fireEvent.click(screen.getByRole('button'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows.join('\n')).not.toMatch(/files\.(delete\.trash|denied)|\bdata:|\binstall:/)
    expect(rows[0]).toContain(i18n.t('history.ops.delete_trash', { ns: 'files' }))
    expect(rows[0]).toContain(i18n.t('roots.labels.data', { ns: 'files' }))
  })
})

describe('why an SFTP root is unavailable', () => {
  it('adds the errors:SFTP_* guidance for the failure the server named', () => {
    const base = i18n.t('roots.unavailable.sftpUnreachable', { ns: 'files' })
    expect(unavailableText('sftpUnreachable', 'SFTP_AUTH_FAILED')).toMatch(/Verify the SFTP username and password/)
    expect(unavailableText('sftpUnreachable', 'SFTP_AUTH_FAILED')).toContain(base)
    expect(unavailableText('sftpUnreachable', 'SFTP_TIMEOUT')).toMatch(/Check the SFTP host, port, firewall/)
    // Anything else is left as the plain reason.
    expect(unavailableText('sftpUnreachable', 'not a code')).toBe(base)
    expect(unavailableText('sftpUnreachable')).toBe(base)
  })
})

describe('commonFolder', () => {
  it('is the deepest folder every path sits in', () => {
    expect(commonFolder(['Server/a.ini', 'Server/b.ini'])).toBe('Server')
    expect(commonFolder(['Server/x/a.ini', 'Server/y/b.ini'])).toBe('Server')
    expect(commonFolder(['a.txt', 'Server/b.ini'])).toBe('')
    expect(commonFolder([])).toBe('')
  })
})
