import { useCallback, useMemo, useRef } from 'react'

// bug-hunt-2026-09-18 (round 9, activeServerChanged race sweep): several
// pages call the same fetch function both on a recurring poll AND on the
// 'activeServerChanged' socket event, with no guard against the two
// overlapping -- e.g. a poll tick fired for the server that was active a
// moment ago is still in flight when the operator switches, and the
// activeServerChanged-triggered call for the NEW server resolves first. Both
// calls do an unconditional setState on their own resolution, so whichever
// RESPONSE lands last wins regardless of which REQUEST was sent last -- the
// older, now-irrelevant answer can silently overwrite the newer one, with no
// further trigger to self-correct (Console.tsx hit this exact shape first;
// see its own consoleTargetRequestIdRef, added the same way by hand before
// this got pulled out as a shared hook once a fourth page needed it).
//
// One instance of this hook guards ONE fetch flow -- a page fetching both
// status and a player roster needs two separate `useRequestGuard()` calls,
// not one shared between them, since either one resolving out of order must
// not affect the other's own freshness check.
export function useRequestGuard() {
  const ref = useRef(0)

  // Call at the START of a fetch attempt; the returned id is this call's
  // ticket. Bumping unconditionally (not just readable) is what makes a
  // still-in-flight OLDER call visibly stale to itself once resolved.
  const next = useCallback(() => ++ref.current, [])

  // Call with the id `next()` returned, at each point the fetch would
  // otherwise apply its result -- true means a newer call has since started
  // and this response must be dropped, not applied.
  const isStale = useCallback((id: number) => id !== ref.current, [])

  // Callers put this object in a useCallback dependency array (the fetcher
  // it guards). Returning a fresh object literal every render -- even with
  // next/isStale themselves stable -- would change THIS object's identity
  // every render, defeating that memoization: any effect depending on the
  // guarded fetcher would re-run (and re-fetch) on every unrelated render,
  // not just when something the fetcher actually needs changes. Caught by
  // Dashboard.activeServerRaceOrder.test.tsx's own setup assertion
  // unexpectedly seeing 3 calls where only 1 was expected before this fix.
  return useMemo(() => ({ next, isStale }), [next, isStale])
}
