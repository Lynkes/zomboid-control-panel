# Evidence Summary: FND-007

- Work package: FND-007 — Hoist the `discordBot.js` import out of the per-test timeout (RISK-001)
- Owner: coordinator
- Reviewer: pending independent verification
- Base SHA: `f9c4619`
- State: review

## Contract

- **Preserved:** all V1 behavior. **No production file touched** — the only change is
  `server/tests/bugfixes.test.js`.
- **New:** the suite is deterministic on a cold run instead of green-by-luck.

## What changed and why this shape

Removed **11 identical** `const { DiscordBot } = await import("../services/discordBot.js");` lines
from inside test bodies, and added one static top-level import.

`import()` is memoised per specifier, so the **first** caller absorbed the entire cold transform
cost of discord.js — 478 files, 4.2 MB — inside its own 5000 ms `testTimeout`. The first caller was
exactly the test that failed.

**A static import was chosen over the recommended `beforeAll`, and the justification was checked
rather than assumed:** the file contains **zero** `vi.mock`, `vi.doMock`, `vi.resetModules`, or
`vi.unmock`, so nothing depends on lazy loading, and it already statically imports
`../routes/auth.js` and `../routes/mods.js`. A collection-time import is gated by **no timeout at
all**, whereas `beforeAll` still runs under `hookTimeout`. The investigating agent named both
options; this is the stronger one.

## The measurement that proves it

| | Before | After |
| --- | --- | --- |
| `forwards ordinary Say chat` | **1488 ms** (warm box) | **1 ms** |
| Its neighbours in the same file | 0–5 ms | 0–5 ms |

The 300–1000x outlier is gone and the test now sits with its peers. That is direct confirmation the
cost was import-bound, exactly as diagnosed — not merely that the failure stopped appearing.

## Results

Server **535/535 across 51 files** — count unchanged, so removing 11 imports dropped or skipped
nothing. Lint clean. Client 90/90. `tsc -b` no diagnostics. Build succeeded. `git diff --check`
exit 0.

## Risks

The new import carries a comment stating why it must not be moved back inline. Without it, a future
reader sees an ordinary import and could reasonably "tidy" it into the helper that uses it —
silently restoring RISK-001 with a green suite on every warm machine.

## Rollback

```powershell
git checkout -- server/tests/bugfixes.test.js
```

The 1488 ms outlier returning is the proof the rollback worked.

## Recommendation

**ACCEPT**, subject to independent verification.
