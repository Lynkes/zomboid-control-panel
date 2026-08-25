# Worktree Lifecycle

Implementation agents use isolated worktrees. Discovery and verification agents are read-only and normally need no worktree.

## Create

Worktrees are prohibited until the user authorizes a **local-only handoff
checkpoint commit** containing `AGENTS.md`, the canonical plan, toolkit, and
accepted FND-001 artifacts. Untracked handoff files do not appear in worktrees.

Use the guarded script:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass `
	-File .\scripts\modernization\create-worktree.ps1 `
	-Id FND-002
```

It refuses unknown packages, untracked handoff files, existing branches, and
existing worktree paths.

Equivalent manual procedure (reference only):

```powershell
$Root = 'D:\Projects\Zomboid_Control_Panel_Modernized'
$Id = 'FND-002'
$Branch = 'modern/' + $Id.ToLowerInvariant()
$Path = "D:\Projects\ZCP-Modernized-worktrees\$Id"

& git -C $Root show-ref --verify --quiet "refs/heads/$Branch"
if ($LASTEXITCODE -eq 0) {
	throw "Branch already exists: $Branch. Reuse/reclaim it explicitly; do not overwrite it."
}
git -C $Root worktree add -b $Branch $Path (git -C $Root rev-parse HEAD)
```

Record path, branch, base SHA, owner, and owned paths in `STATUS.md` before editing.

## Refresh Before Work

- Confirm no other package reserves owned paths.
- If coordinator HEAD moved only in disjoint paths, rebase the package branch onto current coordinator HEAD.
- If shared/coordinator-owned files moved, mark blocked and request integration sequencing. Do not rebase through semantic conflicts autonomously.

## Accepted

After coordinator integration and evidence acceptance:

```powershell
git -C D:\Projects\Zomboid_Control_Panel_Modernized worktree remove $Path
git -C D:\Projects\Zomboid_Control_Panel_Modernized worktree prune
```

Delete the local package branch only after user-authorized commit/integration policy permits it and evidence records the final diff/SHA.

## Rejected

- Preserve evidence and rejected diff patch.
- Remove the worktree only after coordinator confirms no needed forensic files remain.
- Record rejection reason and replacement package, if any.

## Stale Worktree

A worktree is stale when `STATUS.md` says active but the path/branch is missing, owner session is gone, or no evidence/status update exists after a coordinator-defined review interval.

Only the coordinator may reclaim it:

1. inspect worktree/branch status;
2. export uncommitted diff and untracked file list to evidence;
3. mark package blocked;
4. remove/prune worktree;
5. rename the abandoned branch so the canonical package branch can be recreated:

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
git -C $Root branch -m $Branch "abandoned/$($Id.ToLowerInvariant())-$stamp"
```

6. record the abandoned branch name in evidence;
7. return package to ready with a new owner or reject it.
