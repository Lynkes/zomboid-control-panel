import { useCallback, useEffect, useRef, useState } from 'react'
import { modsApi, type ModNote } from '@/lib/api'
import { reportClientWarning } from '@/lib/client-errors'

export interface ModNotesStore {
  notes: Record<string, ModNote>
  /** The note text on a Workshop item, '' when there is none. */
  noteText: (workshopId: string) => string
  /** Saves (or, with empty text, deletes) a note. Rejects with the server's error. */
  saveNote: (workshopId: string, text: string) => Promise<ModNote | null>
}

/** The panel-wide notes on Workshop items (one per item, shared by every admin). */
export function useModNotes(enabled = true): ModNotesStore {
  const [notes, setNotes] = useState<Record<string, ModNote>>({})
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    modsApi.getNotes()
      .then((data) => {
        if (cancelled || !aliveRef.current) return
        setNotes(data?.notes && typeof data.notes === 'object' ? data.notes : {})
      })
      .catch((error) => {
        // Rows simply show no note icon.
        reportClientWarning('Failed to load mod notes.', error)
      })
    return () => { cancelled = true }
  }, [enabled])

  const noteText = useCallback((workshopId: string) => notes[workshopId]?.text ?? '', [notes])

  const saveNote = useCallback(async (workshopId: string, text: string) => {
    const { note } = await modsApi.setNote(workshopId, text)
    if (aliveRef.current) {
      setNotes((previous) => {
        const next = { ...previous }
        if (note) next[workshopId] = note
        else delete next[workshopId]
        return next
      })
    }
    return note ?? null
  }, [])

  return { notes, noteText, saveNote }
}
