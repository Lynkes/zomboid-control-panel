import { afterEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ApiError } from '../api'
import { getResultErrorMessage, getUserErrorMessage } from '../errorMessage'
import { classifyPanelUpdateFailure } from '../panelUpdateFailure'

// 2026-10-01 incident (Unraid all-in-one, 42.21): the Docker panel update's
// pre-update world save kept failing ("RCON connection closed") because the
// game's main thread had died, and Settings > Updates titled it "Download
// Failed" -- nothing had been downloaded, and the message gave no way
// forward. These pin the classification behind the new title and the copy
// that now names Force stop and its cost.

describe('classifyPanelUpdateFailure()', () => {
  it('a save/stop refusal or RCON being down is "server not stopped", not a download failure', () => {
    for (const code of ['save_failed', 'stop_failed', 'SERVER_RUNNING_RCON_UNAVAILABLE']) {
      expect(classifyPanelUpdateFailure(new ApiError('refused', { code }))).toBe('serverNotStopped')
    }
  })

  // Review finding (2026-10-01): a server still running 30 s after a good
  // save and quit was refused as SERVER_STATE_UNKNOWN -- copy about a failed
  // process scan, and no way to the Dashboard.
  it('a server that hasn\'t exited after its shutdown is "server not stopped" too', () => {
    expect(classifyPanelUpdateFailure(new ApiError('hung', { code: 'SERVER_STOP_NOT_CONFIRMED' }))).toBe('serverNotStopped')
  })

  it('an unverifiable server state is its own case (no single next step to offer)', () => {
    expect(classifyPanelUpdateFailure(new ApiError('unknown', { code: 'SERVER_STATE_UNKNOWN' }))).toBe('serverStateUnknown')
  })

  it('everything else is still a download failure', () => {
    expect(classifyPanelUpdateFailure(new ApiError('nope', { code: 'already_downloading' }))).toBe('downloadFailed')
    expect(classifyPanelUpdateFailure(new ApiError('nope', { code: 'HTTP_500' }))).toBe('downloadFailed')
    expect(classifyPanelUpdateFailure(new Error('Not enough free disk space'))).toBe('downloadFailed')
    expect(classifyPanelUpdateFailure(null)).toBe('downloadFailed')
  })
})

describe('the save-failure copy names Force stop and what it costs', () => {
  afterEach(() => {
    void i18n.changeLanguage('en')
  })

  it('SAVE_FAILED_LEGACY (the Docker update refusal), in English', () => {
    void i18n.changeLanguage('en')
    const message = getUserErrorMessage(
      new ApiError('raw', { code: 'save_failed', data: { params: { reason: 'RCON connection closed' } } }),
      'fallback',
    )
    expect(message).toContain('RCON connection closed')
    expect(message).toContain('the update was not applied')
    expect(message).toContain('Force stop on the Dashboard')
    expect(message).toContain('anything since the last successful save can be lost')
  })

  it('SAVE_FAILED_LEGACY, translated, uses the button\'s own label', () => {
    void i18n.changeLanguage('fr')
    const message = getUserErrorMessage(
      new ApiError('raw', { code: 'save_failed', data: { params: { reason: 'RCON connection closed' } } }),
      'fallback',
    )
    expect(message).toContain('« Arrêt forcé »')
    expect(message).toContain('RCON connection closed')
  })

  it('SERVER_RESTART_SAVE_FAILED (a failed Restart\'s toast)', () => {
    void i18n.changeLanguage('en')
    const message = getResultErrorMessage(
      {
        code: 'SERVER_RESTART_SAVE_FAILED',
        params: { reason: 'RCON connection closed' },
        error: 'Save failed; restart cancelled: RCON connection closed',
      },
      '',
    )
    expect(message).toContain('the restart was cancelled')
    expect(message).toContain('Force stop on the Dashboard')
  })

  // Review finding (2026-10-01): a stuck server fails RCON's test command
  // before the save, which used to reach the toast English-only and uncoded.
  it('SERVER_RESTART_RCON_UNAVAILABLE (a stuck server\'s failed Restart), in English and translated', () => {
    void i18n.changeLanguage('en')
    const result = {
      code: 'SERVER_RESTART_RCON_UNAVAILABLE',
      params: { reason: 'RCON connection closed' },
      error: 'RCON not available: RCON connection closed',
    }
    const message = getResultErrorMessage(result, '')
    expect(message).toContain('RCON connection closed')
    expect(message).toContain('the restart was cancelled')
    expect(message).toContain('Force stop on the Dashboard')
    void i18n.changeLanguage('uk')
    const translated = getResultErrorMessage(result, '')
    expect(translated).toContain('«Примусово зупинити»')
    expect(translated).toContain('RCON connection closed')
  })

  // Review finding (2026-10-01): these two said Force stop "tries one quick
  // save" -- it skips the save while RCON is disconnected, which is exactly
  // when they're shown.
  it('the RCON-disconnected refusals don\'t promise a save Force stop can\'t make', () => {
    void i18n.changeLanguage('en')
    for (const code of ['SERVER_STOP_RCON_NOT_CONNECTED', 'SERVER_RUNNING_RCON_UNAVAILABLE']) {
      const message = getUserErrorMessage(new ApiError('raw', { code }), 'fallback')
      expect(message, code).toContain('Force stop')
      expect(message, code).not.toContain('tries one quick save')
      expect(message, code).toContain("while RCON is disconnected it can't save first")
    }
  })

  // Review finding (2026-10-01): a remote server has no Force stop.
  it('a remote server\'s failed Stop sends the operator to its host, not to Force stop', () => {
    void i18n.changeLanguage('en')
    for (const code of ['SERVER_STOP_RCON_NOT_CONNECTED_REMOTE', 'SERVER_STOP_SAVE_FAILED_REMOTE']) {
      const message = getUserErrorMessage(
        new ApiError('raw', { code, data: { params: { reason: 'RCON connection closed' } } }),
        'fallback',
      )
      expect(message, code).not.toContain('use Force stop')
      expect(message, code).toContain('restart it on the machine that hosts it')
    }
  })

  it('SERVER_STOP_SAVE_FAILED now translates (the server sends its reason as a param)', () => {
    void i18n.changeLanguage('de')
    const message = getUserErrorMessage(
      new ApiError('raw', { code: 'SERVER_STOP_SAVE_FAILED', data: { params: { reason: 'RCON connection closed' } } }),
      'fallback',
    )
    expect(message).toContain('„Sofort stoppen“')
    expect(message).toContain('RCON connection closed')
  })
})
