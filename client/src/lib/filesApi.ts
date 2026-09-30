// Client for the Server Files API (base /api/files, spec §A10). Every JSON
// call goes through api.ts's apiFetch/handleResponse, so it gets the same
// timeout, the one TOKEN_EXPIRED replay, the Retry-After parsing and the
// backupWarning toast as the rest of the panel. Uploads are an XHR (for
// upload progress and abort) that carries the bearer header the same way;
// downloads are fetch -> blob -> object URL, like downloadBackup. The token
// never goes into a URL.
import { ApiError, apiFetch, buildResponseError, handleResponse, tryRefreshToken } from './api'
import { getAccessToken } from './authToken'
import {
  UPLOAD_HEADERS,
  type AuditResponse,
  type ConfirmToken,
  type ConfirmationRequiredBody,
  type CopyRequest,
  type DeletePreviewRequest,
  type DeletePreviewResponse,
  type DeleteRequest,
  type DeleteTrashResponse,
  type EntryResponse,
  type JobResponse,
  type JobStartedResponse,
  type ListQuery,
  type ListResponse,
  type MkdirRequest,
  type MoveRequest,
  type MoveResponse,
  type ProfileResponse,
  type ProfilesResponse,
  type RemoteRootsRequest,
  type RenameRequest,
  type RootId,
  type SearchQuery,
  type SearchResponse,
  type StatQuery,
  type StatResponse,
  type TextQuery,
  type TextResponse,
  type TextSaveRequest,
  type TextSaveResponse,
  type TrashListResponse,
  type TrashPurgeRequest,
  type TrashQuery,
  type TrashRestoreManyRequest,
  type TrashRestoreManyResponse,
  type TrashRestoreRequest,
  type TrashTextQuery,
  type TrashTextResponse,
  type UploadPreflightRequest,
  type UploadPreflightResponse,
  type UploadResponse,
  type ZipRequest,
} from '@/types/files'

const API_BASE = '/api'
const FILES_BASE = '/files'

// Headers (not body) arrive within this; a large body then streams for as
// long as it takes (fetchWithRetry clears its timer once headers are in).
const DOWNLOAD_HEADERS_TIMEOUT_MS = 60_000
// Over SFTP the server itself may take a 10 s connect plus 20 s per step,
// and probes a remote server's folders one connection at a time: a read
// waits longer than api.ts's 15 s default, and isn't sent again on a
// timeout (the server would only do the same slow work once more; the page
// has its own Try again).
const READ_TIMEOUT_MS = 45_000
// A read that failed on the way there or back is sent again after a short
// wait (1, 2, 4 s, or what a 429's Retry-After asks up to 8 s): the network
// dropped, a proxy in front of the panel answered 5xx, or the panel's
// per-minute limit answered 429. Never after a timeout, or an answer the
// file manager gave itself (FM_SFTP_TIMEOUT, FM_RATE_LIMITED...): that
// would only repeat the same slow or refused work.
const READ_RETRIES = 3
const READ_RETRY_BASE_MS = 1000
const READ_RETRY_MAX_MS = 8000
// Mutations the server may do over a slow SFTP link, reporting a timeout
// for a change that then happens anyway.
const WRITE_TIMEOUT_MS = 60_000

// ---- Paths (POSIX segments joined by "/", "" is the root) ----

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

export function pathSegments(path: string): string[] {
  return path ? path.split('/') : []
}

// ---- Request helpers ----

function profileEndpoint(profileId: string, sub: string): string {
  return `${FILES_BASE}/profiles/${encodeURIComponent(profileId)}${sub}`
}

type QueryValue = string | number | boolean | undefined | null

function withQuery(endpoint: string, params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `${endpoint}?${query}` : endpoint
}

/** A failure on the way (network, proxy, the panel-wide limit), not an answer or a timeout. */
function isTransientReadFailure(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.isTimeout) return false
  if (error.code?.startsWith('FM_')) return false
  if (error.status === undefined) return error.isNetworkError
  return error.status === 429 || error.status >= 500
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function getJson<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      // api.ts's own transport retries would resend a timed-out read too.
      const response = await apiFetch(endpoint, { signal, timeout: READ_TIMEOUT_MS, retries: 0 })
      return await handleResponse<T>(response)
    } catch (error) {
      if (attempt >= READ_RETRIES || signal?.aborted || !isTransientReadFailure(error)) throw error
      const asked = error instanceof ApiError && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : 0
      await wait(Math.min(Math.max(asked, READ_RETRY_BASE_MS * 2 ** attempt), READ_RETRY_MAX_MS), signal)
      if (signal?.aborted) throw error
    }
  }
}

// Mutating routes require Content-Type: application/json (spec §A2, 415
// otherwise), so it's set even for a body-less call.
async function sendJson<T>(method: 'POST' | 'PUT', endpoint: string, body: unknown, options?: { timeout?: number }): Promise<T> {
  const response = await apiFetch(endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    timeout: options?.timeout,
  })
  return handleResponse<T>(response)
}

// ---- JSON routes ----

export const filesApi = {
  listProfiles: (signal?: AbortSignal) =>
    getJson<ProfilesResponse>(`${FILES_BASE}/profiles`, signal),

  getProfile: (profileId: string, options?: { fresh?: boolean; signal?: AbortSignal }) =>
    getJson<ProfileResponse>(withQuery(profileEndpoint(profileId, ''), { fresh: options?.fresh ? 1 : undefined }), options?.signal),

  list: (profileId: string, query: ListQuery, signal?: AbortSignal) =>
    getJson<ListResponse>(withQuery(profileEndpoint(profileId, '/list'), { ...query }), signal),

  stat: (profileId: string, query: StatQuery) =>
    getJson<StatResponse>(withQuery(profileEndpoint(profileId, '/stat'), { ...query })),

  search: (profileId: string, query: SearchQuery, signal?: AbortSignal) =>
    getJson<SearchResponse>(withQuery(profileEndpoint(profileId, '/search'), { ...query }), signal),

  getText: (profileId: string, query: TextQuery, signal?: AbortSignal) =>
    getJson<TextResponse>(withQuery(profileEndpoint(profileId, '/text'), { ...query }), signal),

  // A 2 MiB file JSON-escapes to at most ~6 MB; give the body time to go up.
  saveText: (profileId: string, body: TextSaveRequest) =>
    sendJson<TextSaveResponse>('PUT', profileEndpoint(profileId, '/text'), body, { timeout: 60_000 }),

  mkdir: (profileId: string, body: MkdirRequest) =>
    sendJson<EntryResponse>('POST', profileEndpoint(profileId, '/mkdir'), body, { timeout: WRITE_TIMEOUT_MS }),

  rename: (profileId: string, body: RenameRequest) =>
    sendJson<EntryResponse>('POST', profileEndpoint(profileId, '/rename'), body, { timeout: WRITE_TIMEOUT_MS }),

  move: (profileId: string, body: MoveRequest) =>
    sendJson<MoveResponse>('POST', profileEndpoint(profileId, '/move'), body, { timeout: 60_000 }),

  copy: (profileId: string, body: CopyRequest) =>
    sendJson<EntryResponse>('POST', profileEndpoint(profileId, '/copy'), body, { timeout: 120_000 }),

  deletePreview: (profileId: string, body: DeletePreviewRequest) =>
    sendJson<DeletePreviewResponse>('POST', profileEndpoint(profileId, '/delete/preview'), body, { timeout: 30_000 }),

  deleteToTrash: (profileId: string, body: DeleteRequest & { mode: 'trash' }) =>
    sendJson<DeleteTrashResponse>('POST', profileEndpoint(profileId, '/delete'), body, { timeout: 60_000 }),

  deletePermanently: (profileId: string, body: DeleteRequest & { mode: 'permanent' }) =>
    sendJson<JobStartedResponse>('POST', profileEndpoint(profileId, '/delete'), body, { timeout: WRITE_TIMEOUT_MS }),

  // `timeout`: a big batch into a remote (SFTP) root takes a round trip or
  // two per file; the page scales the wait to the batch.
  uploadPreflight: (profileId: string, body: UploadPreflightRequest, options?: { timeout?: number }) =>
    sendJson<UploadPreflightResponse>('POST', profileEndpoint(profileId, '/upload/preflight'), body, { timeout: options?.timeout ?? 30_000 }),

  trashList: (profileId: string, query: TrashQuery, signal?: AbortSignal) =>
    getJson<TrashListResponse>(withQuery(profileEndpoint(profileId, '/trash'), { ...query }), signal),

  trashRestore: (profileId: string, body: TrashRestoreRequest) =>
    sendJson<EntryResponse>('POST', profileEndpoint(profileId, '/trash/restore'), body, { timeout: WRITE_TIMEOUT_MS }),

  // Several items in one request (Undo of a bulk delete): one confirmation
  // and one rate-limit hit, per-item results.
  trashRestoreMany: (profileId: string, body: TrashRestoreManyRequest) =>
    sendJson<TrashRestoreManyResponse>('POST', profileEndpoint(profileId, '/trash/restore'), body, { timeout: 120_000 }),

  trashPurge: (profileId: string, body: TrashPurgeRequest) =>
    sendJson<JobStartedResponse>('POST', profileEndpoint(profileId, '/trash/purge'), body, { timeout: WRITE_TIMEOUT_MS }),

  // Saving re-probes the remote folders before answering.
  setRemoteRoots: (profileId: string, body: RemoteRootsRequest) =>
    sendJson<ProfileResponse>('PUT', profileEndpoint(profileId, '/remote-roots'), body, { timeout: 90_000 }),

  getJob: (jobId: string) =>
    getJson<JobResponse>(`${FILES_BASE}/jobs/${encodeURIComponent(jobId)}`),

  getAudit: (profileId: string, limit = 50, signal?: AbortSignal) =>
    getJson<AuditResponse>(withQuery(`${FILES_BASE}/audit`, { profileId, limit }), signal),

  // An earlier version's text out of Trash, for the editor's "Previous
  // versions" menu (decoded like GET /text mode=edit).
  getTrashText: (profileId: string, query: TrashTextQuery) =>
    getJson<TrashTextResponse>(withQuery(profileEndpoint(profileId, '/trash/text'), { ...query })),
}

// ---- Jobs (permanent delete, Trash purge) ----

// The job keeps running on the server whatever happens to one poll: a
// poll that fails on the way (after its own retries), or times out, is
// followed by the next one, and only this many of them in a row end the
// wait. An answer (FM_JOB_NOT_FOUND...) ends it at once.
const JOB_POLL_FAILURES_TOLERATED = 5

export async function waitForJob(
  jobId: string,
  onProgress: (job: JobResponse) => void,
  options?: { intervalMs?: number; signal?: AbortSignal },
): Promise<JobResponse> {
  const intervalMs = options?.intervalMs ?? 1000
  let failures = 0
  for (;;) {
    let job: JobResponse
    try {
      job = await filesApi.getJob(jobId)
      failures = 0
    } catch (error) {
      const onTheWay = isTransientReadFailure(error) || (error instanceof ApiError && error.isTimeout)
      if (!onTheWay || options?.signal?.aborted || ++failures > JOB_POLL_FAILURES_TOLERATED) throw error
      await wait(intervalMs, options?.signal)
      continue
    }
    onProgress(job)
    if (job.state !== 'running') return job
    if (options?.signal?.aborted) return job
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

// ---- Confirmations (spec §A8) ----

export function confirmationRequiredBody(error: unknown): ConfirmationRequiredBody | null {
  if (!(error instanceof ApiError) || error.code !== 'FM_CONFIRMATION_REQUIRED') return null
  const data = error.data as Partial<ConfirmationRequiredBody> | undefined
  const required = data?.params?.required
  if (!Array.isArray(required)) return null
  return data as ConfirmationRequiredBody
}

export type ConfirmedResult<T> = { ok: true; value: T } | { ok: false }

/**
 * Runs `run` with `initial` tokens. When the server answers
 * FM_CONFIRMATION_REQUIRED, asks once (`ask`) and retries once with the
 * tokens it named; a second FM_CONFIRMATION_REQUIRED is thrown like any
 * other error. `{ ok: false }` means the operator said no.
 */
export async function withConfirmations<T>(
  run: (confirm: ConfirmToken[]) => Promise<T>,
  ask: (body: ConfirmationRequiredBody) => Promise<boolean>,
  initial: ConfirmToken[] = [],
): Promise<ConfirmedResult<T>> {
  try {
    return { ok: true, value: await run(initial) }
  } catch (error) {
    const body = confirmationRequiredBody(error)
    if (!body) throw error
    if (!(await ask(body))) return { ok: false }
    const tokens = [...new Set<ConfirmToken>([...initial, ...body.params.required])]
    return { ok: true, value: await run(tokens) }
  }
}

// The client may remember a serverRunning acknowledgement per profile for
// 10 minutes (§A8), in memory only. Every other token is asked every time,
// and the server still checks every request.
const SERVER_RUNNING_ACK_MS = 10 * 60 * 1000
const serverRunningAcks = new Map<string, number>()

export function rememberServerRunningAck(profileId: string, now = Date.now()): void {
  serverRunningAcks.set(profileId, now + SERVER_RUNNING_ACK_MS)
}

export function hasServerRunningAck(profileId: string, now = Date.now()): boolean {
  const until = serverRunningAcks.get(profileId)
  if (until === undefined) return false
  if (until <= now) {
    serverRunningAcks.delete(profileId)
    return false
  }
  return true
}

export function forgetServerRunningAcks(): void {
  serverRunningAcks.clear()
}

// ---- Downloads ----

function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (header) {
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
    if (encoded) {
      try {
        const decoded = decodeURIComponent(encoded[1].trim())
        if (decoded) return decoded
      } catch {
        // malformed escape: fall through to the plain form
      }
    }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header)
    if (plain?.[1]) return plain[1]
  }
  return fallback
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName.replace(/[\\/]/g, '_')
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // Revoked on the next tick: some browsers start the save asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function throwForResponse(response: Response): Promise<never> {
  let payload: unknown = null
  const contentType = response.headers.get('content-type') || ''
  try {
    payload = contentType.includes('application/json') ? await response.json() : await response.text()
  } catch {
    payload = null
  }
  throw buildResponseError(response, payload)
}

export interface DownloadResult {
  fileName: string
  masked: boolean
}

export async function downloadFile(profileId: string, query: { root: RootId; path: string }): Promise<DownloadResult> {
  const response = await apiFetch(withQuery(profileEndpoint(profileId, '/download'), { ...query }), {
    timeout: DOWNLOAD_HEADERS_TIMEOUT_MS,
  })
  if (!response.ok) await throwForResponse(response)
  const fileName = fileNameFromDisposition(response.headers.get('content-disposition'), baseName(query.path) || 'download')
  const masked = response.headers.get('x-file-masked') === '1'
  saveBlob(await response.blob(), fileName)
  return { fileName, masked }
}

export async function downloadZip(profileId: string, body: ZipRequest): Promise<DownloadResult> {
  const response = await apiFetch(profileEndpoint(profileId, '/zip'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: DOWNLOAD_HEADERS_TIMEOUT_MS,
  })
  if (!response.ok) await throwForResponse(response)
  const fileName = fileNameFromDisposition(response.headers.get('content-disposition'), 'files.zip')
  saveBlob(await response.blob(), fileName)
  return { fileName, masked: false }
}

// ---- Upload (XHR) ----

export interface UploadRequest {
  profileId: string
  root: RootId
  /** Destination folder, root-relative. */
  dir: string
  name: string
  file: Blob
  /** Create missing folders of `dir` (folder uploads). */
  mkdirs: boolean
  /** The etag the preflight saw; set only when replacing. */
  overwriteEtag: string | null
  confirm: ConfirmToken[]
}

export interface UploadHandle {
  promise: Promise<UploadResponse>
  abort: () => void
}

export const UPLOAD_ABORTED = 'UPLOAD_ABORTED'

function parseXhrPayload(xhr: XMLHttpRequest): unknown {
  const text = xhr.responseText
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// Builds the same ApiError apiFetch callers get (message, code, data,
// retryAfterSeconds) from an XHR's status, headers and body.
function xhrError(xhr: XMLHttpRequest, payload: unknown): ApiError {
  const headers = new Headers()
  const retryAfter = xhr.getResponseHeader('Retry-After')
  if (retryAfter) headers.set('Retry-After', retryAfter)
  // Response() only takes 200-599; an XHR that "loaded" with anything else
  // never reached the panel, which reads best as a gateway failure.
  const status = xhr.status >= 200 && xhr.status <= 599 ? xhr.status : 502
  const response = new Response(null, { status, headers })
  return buildResponseError(response, payload)
}

function sendUploadOnce(
  request: UploadRequest,
  token: string | null,
  onProgress: (loaded: number, total: number) => void,
  register: (xhr: XMLHttpRequest) => void,
): Promise<{ xhr: XMLHttpRequest; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    register(xhr)
    xhr.open('POST', `${API_BASE}${profileEndpoint(request.profileId, '/upload')}`, true)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader(UPLOAD_HEADERS.root, request.root)
    xhr.setRequestHeader(UPLOAD_HEADERS.dir, encodeURIComponent(request.dir))
    xhr.setRequestHeader(UPLOAD_HEADERS.name, encodeURIComponent(request.name))
    if (request.mkdirs) xhr.setRequestHeader(UPLOAD_HEADERS.mkdirs, '1')
    if (request.overwriteEtag) xhr.setRequestHeader(UPLOAD_HEADERS.overwriteEtag, request.overwriteEtag)
    if (request.confirm.length > 0) xhr.setRequestHeader(UPLOAD_HEADERS.confirm, request.confirm.join(','))
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onload = () => resolve({ xhr, payload: parseXhrPayload(xhr) })
    xhr.onerror = () =>
      reject(new ApiError('Unable to reach the server. Check your network connection and try again.', {
        code: 'NETWORK_ERROR',
        isRetryable: true,
        isNetworkError: true,
      }))
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', { code: UPLOAD_ABORTED }))
    xhr.send(request.file)
  })
}

/**
 * One file upload. Rejects with an ApiError (a 429 carries
 * retryAfterSeconds; `code: UPLOAD_ABORTED` after abort()). An expired
 * access token is refreshed and the upload replayed once, like apiFetch.
 */
export function uploadFile(request: UploadRequest, onProgress: (loaded: number, total: number) => void): UploadHandle {
  let current: XMLHttpRequest | null = null
  let aborted = false
  const register = (xhr: XMLHttpRequest) => {
    current = xhr
  }
  const promise = (async () => {
    let { xhr, payload } = await sendUploadOnce(request, getAccessToken(), onProgress, register)
    const code = payload && typeof payload === 'object' ? (payload as { code?: unknown }).code : undefined
    if (xhr.status === 401 && code === 'TOKEN_EXPIRED' && !aborted) {
      if (await tryRefreshToken()) {
        if (aborted) throw new ApiError('Upload cancelled.', { code: UPLOAD_ABORTED })
        ;({ xhr, payload } = await sendUploadOnce(request, getAccessToken(), onProgress, register))
      }
    }
    if (xhr.status >= 200 && xhr.status < 300 && payload && typeof payload === 'object') {
      return payload as UploadResponse
    }
    throw xhrError(xhr, payload)
  })()
  return {
    promise,
    abort: () => {
      aborted = true
      current?.abort()
    },
  }
}
