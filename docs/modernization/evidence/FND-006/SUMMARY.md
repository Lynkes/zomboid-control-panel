# Evidence Summary: FND-006

- Work package: FND-006 — Harden the owned-path guard (DISC-002) and correct the plan text
- Owner: coordinator
- Reviewer: pending independent verification
- Base SHA: `f9c4619`
- State: review

## Contract

- **Preserved:** all V1 behavior. No production file touched. Changes are one toolkit script and
  one documentation note.
- **New:** `check-owned-paths.ps1` splits `-AllowedPath` on commas and **refuses** an argument that
  yields no usable entries, instead of silently proceeding with an empty allow-list.

## The three tests, because a guard needs all three

A guard is only proven by showing it can *fail*. One acceptance run would have proven nothing.

| Case | Expected | Result |
| --- | --- | --- |
| **Accept** — `-File` with the plan's comma list | PASS, exit 0 | `PASS ... changed=3`, exit 0 |
| **Refuse** — `-AllowedPath " , , "` | throw, non-zero | `-AllowedPath produced no usable entries`, exit 1 |
| **Not weakened** — a genuinely unowned file present | FAIL, non-zero | `FAIL` / `UNOWNED NOT_OWNED_PROBE.tmp`, exit 1 |

The third case is the one that mattered most: hardening a guard risks making it permissive, and
this proves a real ownership violation is still caught. The probe file was removed in a `finally`
block and its absence verified.

**A trap I walked into while testing:** the refuse case first read `exit 0`. That was
`Select-Object -First 3` terminating the pipeline early and leaving a stale `$LASTEXITCODE` — the
throw *had* happened. Re-run without a pipe, it is exit 1. A piped gate reports the pipe's status,
not the runner's.

## I withdrew half of this package's original scope

FND-006 was going to harden **two** guards. It hardened one, because the second defect was not real.

**DISC-002b is retracted.** I claimed an abbreviated `current_sha` made `bootstrap-plan.ps1` skip
its staleness check silently. It does not — it prints
`WARN STATUS.md has no concrete current_sha`. I had filtered my own output with a pattern containing
`status-current` but not `WARN`, then reported the missing line as a finding. My first attempt to
reproduce it also silently did nothing: the regex ended in `"$` and the file has CRLF endings, so
the substitution never applied and the run exercised the 40-char path — appearing to confirm the
bug.

`bootstrap-plan.ps1` is therefore **unchanged**. There is one broken guard, not two, and the earlier
"two guards" framing in commit messages and STATUS was wrong.

The irony is the lesson: DISC-002b was meant to be a second example of a check that reports success
without evaluating its input, and it turned out to be me doing exactly that, twice.

## A self-inflicted gate failure

`git diff --check` failed with trailing whitespace on **every line** of `DECISIONS.md`. Cause: my
scripted Python edits emitted CRLF on Windows into files git had committed as LF, and
`.gitattributes` has no `*.md` rule, so git read each `\r` as literal content. Repaired by
normalizing the five modified files back to LF; `git diff --check` now exits 0.

Recorded because it will recur: **any scripted edit in this repo must write LF explicitly.**

## Results

Server 535/535 across 51 files, lint clean at `--max-warnings=0`, `git diff --check` exit 0,
owned-path check `PASS ... changed=5` using the hardened guard.

## Rollback

```powershell
git checkout -- scripts/modernization/check-owned-paths.ps1 V2_MODERNIZATION_PLAN.md
```

Verification that the old behavior is back: `-AllowedPath " , , "` returns exit 0 again instead of
throwing. The defect reappearing is the proof.

## Recommendation

**ACCEPT**, subject to independent verification — including a re-check of the DISC-002b retraction,
since a withdrawn finding deserves the same scrutiny as a filed one.
