import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * A page's selection kept in one query parameter (?tab=, ?view=, ?section=),
 * so it survives a reload and can be linked to. A value outside `allowed`
 * (an old bookmark, a typo) reads as `fallback`. Writing replaces the
 * history entry (switching tabs is not a navigation Back should step
 * through) and keeps every other parameter.
 */
export function useUrlParamState<T extends string>(
  param: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams()
  const raw = searchParams.get(param)
  const value = raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback

  const setValue = useCallback(
    (next: T) => {
      setSearchParams(
        (previous) => {
          const updated = new URLSearchParams(previous)
          updated.set(param, next)
          return updated
        },
        { replace: true },
      )
    },
    [param, setSearchParams],
  )

  return [value, setValue]
}
