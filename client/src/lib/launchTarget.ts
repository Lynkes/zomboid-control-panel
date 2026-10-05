// Client mirror of server/routes/servers.js's changesLaunchTarget()
// (RCE-STARTCMD, 2026-10-04): a server's start command, an install path
// naming a launcher script (.bat/.sh/.exe, serverManager.js's
// resolveLaunchMode()), and the install path of a server that has either
// before or after the edit decide a program the panel runs on the host, so
// only files.manage may change them. UX only -- it lets a role without
// files.manage see why a control is disabled instead of meeting a refusal
// after Save. The server decides.

type LaunchFields = {
  startCommand?: string | null
  installPath?: string | null
  serverPath?: string | null
}

const LAUNCHER_PATH_RE = /\.(bat|sh|exe)$/i

export function isLauncherPath(value: string | null | undefined): boolean {
  return !!value && LAUNCHER_PATH_RE.test(value)
}

export function launchIsOperatorDefined(server: LaunchFields | null | undefined): boolean {
  return !!String(server?.startCommand ?? '').trim() || isLauncherPath(server?.serverPath || server?.installPath)
}

const LAUNCH_KEYS = ['startCommand', 'installPath', 'serverPath'] as const

export function changesLaunchTarget(stored: LaunchFields, edited: LaunchFields): boolean {
  const differs = (key: keyof LaunchFields) =>
    edited[key] !== undefined && String(edited[key] ?? '') !== String(stored[key] ?? '')
  if (differs('startCommand')) return true
  const after: LaunchFields = { ...stored }
  for (const key of LAUNCH_KEYS) {
    if (edited[key] !== undefined) after[key] = edited[key]
  }
  return (['installPath', 'serverPath'] as const).some(
    (key) =>
      differs(key) &&
      (isLauncherPath(edited[key]) || launchIsOperatorDefined(stored) || launchIsOperatorDefined(after)),
  )
}
