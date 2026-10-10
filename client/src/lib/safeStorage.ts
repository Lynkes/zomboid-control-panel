// localStorage throws, rather than returning null, where site data is blocked
// (some privacy modes, sandboxed frames, a full quota). Anything the shell
// reads while rendering has to go through here so a browser that refuses
// storage still gets a working panel, just one that forgets between visits.

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Saves a value; false when the browser refused. */
export function writeStored(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
