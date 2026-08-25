# Integration Procedure

Only the coordinator integrates accepted work packages.

## Preconditions

- Package is in `review`.
- Independent `VERIFICATION.md` is complete.
- Worktree is clean except declared changes.
- Package branch is based on the recorded integration SHA or has completed the rebase procedure.
- Owned paths match `DIFF_SCOPE.md`.

## Integration

1. In the coordinator worktree, record the current SHA and run the current full gate.
2. Fetch local worktree branch refs only; no remote operation.
3. Review `git diff <integration-sha>...modern/<wp-id>` and evidence.
4. Integrate implementation-owned commits using a no-commit merge or cherry-pick only when local commits are user-authorized. Without commit authorization, apply a reviewed patch produced by `git diff --binary`.
5. Apply coordinator-owned hunks separately, after implementation-owned paths, in dependency order.
6. Resolve no semantic conflict by guesswork. Return the package to `blocked` and use `CONFLICT_RESOLUTION.md`.
7. Run focused tests, package gates, then the complete V1 gate.
8. Update program artifacts and mark accepted only after all gates pass.
9. Record the integrated SHA/diff hash in package evidence.

## Failed Integration

- Abort merge/cherry-pick or reverse only the uncommitted patch.
- Never reset unrelated coordinator/user changes.
- Preserve failed command output in evidence.
- Return package to `ready` or `blocked` with the exact failure.

## Post-Integration

- Update `STATUS.md` and `STATUS_ARCHIVE.md`.
- Release owned-path reservations.
- Remove worktree using `WORKTREE_LIFECYCLE.md` after evidence is durable.
- Do not begin a dependent package until coordinator/user milestone rules allow it.
