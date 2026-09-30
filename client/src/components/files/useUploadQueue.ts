// The upload queue behind UploadQueue.tsx: two uploads at a time, per-file
// progress, cancel and retry, and a pause on 429 that resumes after the
// server's Retry-After (the global limiter is 300/min per IP, so a folder of
// several hundred files will hit it). Also the two ways files arrive: a file
// or folder <input>, and a drop read through webkitGetAsEntry.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/api'
import { UPLOAD_ABORTED, uploadFile, type UploadHandle } from '@/lib/filesApi'
import type { ConfirmToken, RootId } from '@/types/files'

export const UPLOAD_CONCURRENCY = 2
// Used when a 429 carries no usable Retry-After.
const DEFAULT_PAUSE_SECONDS = 10

export type UploadStatus = 'waiting' | 'uploading' | 'done' | 'failed' | 'cancelled' | 'skipped'

export interface PickedFile {
  file: File
  /** "name", or "sub/dir/name" for a folder upload. */
  relPath: string
}

export interface UploadJob {
  profileId: string
  root: RootId
  /** Destination folder, root-relative, including any sub folders of relPath. */
  dir: string
  name: string
  relPath: string
  file: File
  mkdirs: boolean
  overwriteEtag: string | null
  confirm: ConfirmToken[]
}

export interface UploadItem extends UploadJob {
  id: string
  status: UploadStatus
  loaded: number
  total: number
  /** Translated reason, for failed items. */
  error: string | null
}

interface UseUploadQueueOptions {
  describeError: (error: unknown) => string
  /** Called once each time the queue drains after doing some work. */
  onDrained: () => void
}

let nextId = 0
function newId(): string {
  nextId += 1
  return `upload-${nextId}`
}

export function useUploadQueue({ describeError, onDrained }: UseUploadQueueOptions) {
  const itemsRef = useRef<UploadItem[]>([])
  const handlesRef = useRef(new Map<string, UploadHandle>())
  const pausedUntilRef = useRef<number | null>(null)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workedRef = useRef(false)
  const optionsRef = useRef({ describeError, onDrained })
  optionsRef.current = { describeError, onDrained }

  const [items, setItems] = useState<UploadItem[]>([])
  const [pausedUntil, setPausedUntil] = useState<number | null>(null)
  const [allDone, setAllDone] = useState(false)

  const publish = useCallback(() => {
    setItems([...itemsRef.current])
  }, [])

  const update = useCallback((id: string, patch: Partial<UploadItem>) => {
    itemsRef.current = itemsRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item))
  }, [])

  const pumpRef = useRef<() => void>(() => {})

  const checkDrained = useCallback(() => {
    const busy = itemsRef.current.some((item) => item.status === 'waiting' || item.status === 'uploading')
    if (!busy && workedRef.current) {
      workedRef.current = false
      setAllDone(true)
      optionsRef.current.onDrained()
    }
  }, [])

  const start = useCallback((item: UploadItem) => {
    workedRef.current = true
    update(item.id, { status: 'uploading', loaded: 0, error: null })
    const handle = uploadFile(
      {
        profileId: item.profileId,
        root: item.root,
        dir: item.dir,
        name: item.name,
        file: item.file,
        mkdirs: item.mkdirs,
        overwriteEtag: item.overwriteEtag,
        confirm: item.confirm,
      },
      (loaded, total) => {
        update(item.id, { loaded, total })
        publish()
      },
    )
    handlesRef.current.set(item.id, handle)
    handle.promise
      .then(() => {
        update(item.id, { status: 'done', loaded: item.total, error: null })
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === UPLOAD_ABORTED) {
          update(item.id, { status: 'cancelled', error: null })
          return
        }
        if (error instanceof ApiError && error.status === 429) {
          // Back into the queue, and everything waits for the server.
          update(item.id, { status: 'waiting', loaded: 0, error: null })
          const seconds = error.retryAfterSeconds ?? DEFAULT_PAUSE_SECONDS
          const until = Date.now() + Math.max(1, seconds) * 1000
          pausedUntilRef.current = Math.max(pausedUntilRef.current ?? 0, until)
          setPausedUntil(pausedUntilRef.current)
          if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = setTimeout(() => {
            resumeTimerRef.current = null
            pausedUntilRef.current = null
            setPausedUntil(null)
            pumpRef.current()
          }, pausedUntilRef.current - Date.now())
          return
        }
        update(item.id, { status: 'failed', error: optionsRef.current.describeError(error) })
      })
      .finally(() => {
        handlesRef.current.delete(item.id)
        publish()
        pumpRef.current()
      })
  }, [publish, update])

  const pump = useCallback(() => {
    if (pausedUntilRef.current !== null) {
      publish()
      return
    }
    let running = itemsRef.current.filter((item) => item.status === 'uploading').length
    for (const item of itemsRef.current) {
      if (running >= UPLOAD_CONCURRENCY) break
      if (item.status !== 'waiting') continue
      start(item)
      running += 1
    }
    publish()
    checkDrained()
  }, [checkDrained, publish, start])
  pumpRef.current = pump

  const enqueue = useCallback((jobs: UploadJob[], skipped: PickedFile[] = [], failed: Array<{ job: UploadJob; error: string }> = []) => {
    setAllDone(false)
    const added: UploadItem[] = [
      ...jobs.map((job) => ({ ...job, id: newId(), status: 'waiting' as const, loaded: 0, total: job.file.size, error: null })),
      ...failed.map(({ job, error }) => ({ ...job, id: newId(), status: 'failed' as const, loaded: 0, total: job.file.size, error })),
    ]
    const skippedItems: UploadItem[] = skipped.map((picked) => ({
      profileId: '',
      root: 'data',
      dir: '',
      name: picked.file.name,
      relPath: picked.relPath,
      file: picked.file,
      mkdirs: false,
      overwriteEtag: null,
      confirm: [],
      id: newId(),
      status: 'skipped',
      loaded: 0,
      total: picked.file.size,
      error: null,
    }))
    itemsRef.current = [...itemsRef.current, ...added, ...skippedItems]
    if (jobs.length > 0) workedRef.current = true
    pump()
  }, [pump])

  const cancel = useCallback((id: string) => {
    const handle = handlesRef.current.get(id)
    if (handle) {
      handle.abort()
      return
    }
    update(id, { status: 'cancelled' })
    publish()
    checkDrained()
  }, [checkDrained, publish, update])

  const cancelAll = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.status === 'waiting') update(item.id, { status: 'cancelled' })
    }
    for (const handle of handlesRef.current.values()) handle.abort()
    publish()
    checkDrained()
  }, [checkDrained, publish, update])

  const retry = useCallback((id: string) => {
    setAllDone(false)
    update(id, { status: 'waiting', loaded: 0, error: null })
    workedRef.current = true
    pump()
  }, [pump, update])

  const clearFinished = useCallback(() => {
    itemsRef.current = itemsRef.current.filter((item) => item.status === 'waiting' || item.status === 'uploading')
    setAllDone(false)
    publish()
  }, [publish])

  useEffect(() => () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    for (const handle of handlesRef.current.values()) handle.abort()
  }, [])

  const active = items.some((item) => item.status === 'waiting' || item.status === 'uploading')
  return { items, pausedUntil, active, allDone, enqueue, cancel, cancelAll, retry, clearFinished }
}

// ---- Where files come from ----

/** Files from an <input type="file">, keeping a folder upload's sub folders. */
export function pickedFromInput(list: FileList | null): PickedFile[] {
  if (!list) return []
  return Array.from(list).map((file) => ({
    file,
    relPath: file.webkitRelativePath || file.name,
  }))
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

function readAllDirectoryEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader()
  const all: FileSystemEntry[] = []
  return new Promise((resolve, reject) => {
    // readEntries returns at most ~100 entries per call; keep reading until
    // it returns an empty batch.
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        readBatch()
      }, reject)
    }
    readBatch()
  })
}

/**
 * Files dropped on the page, walking dropped folders. Stops once it has
 * more than `limit` files, so the caller can refuse an oversized drop
 * without reading all of it.
 */
export async function pickedFromDrop(dataTransfer: DataTransfer, limit: number): Promise<PickedFile[]> {
  const out: PickedFile[] = []
  const entries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))

  if (entries.length === 0 || entries.every((entry) => entry === null)) {
    return Array.from(dataTransfer.files ?? []).map((file) => ({ file, relPath: file.name }))
  }

  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > limit) return
    if (entry.isFile) {
      const file = await readFileEntry(entry as FileSystemFileEntry)
      out.push({ file, relPath: `${prefix}${entry.name}` })
      return
    }
    if (entry.isDirectory) {
      const children = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry)
      for (const child of children) {
        if (out.length > limit) return
        await walk(child, `${prefix}${entry.name}/`)
      }
    }
  }

  for (const entry of entries) {
    if (entry) await walk(entry, '')
    if (out.length > limit) break
  }
  return out
}
