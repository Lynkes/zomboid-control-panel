# V2 Source Provenance: FND-001

- V2 source repository: `D:\Projects\Zomboid_dev_panel V2`
- V2 source commit: **not applicable — no V2 source was read, copied, or adapted**
- V1 fork baseline: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`)

| V2 source path | Symbols/concepts used | Modernization target path | Ported/copied/adapted | Deliberate deviations | Tests |
| --- | --- | --- | --- | --- | --- |
| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |

**Nil return, stated explicitly.** FND-001 ported no V2 code and no V2 concept. Its deliverables
are program ledgers, a baseline record, and evidence. The V2 reference tree was never opened during
this package; the V1 source reference at `D:\Zomboid_dev_panel\GitHub` was likewise never read.
Neither reference repository was modified.

This file exists rather than being omitted because "no provenance" and "provenance not recorded"
are different claims, and only the first is verifiable later.

## Dependency/License Review

- Existing project license compatibility: unchanged. No file under `LICENSE` or any notice was
  touched.
- New dependencies: **none.** `npm ci` installed exactly what the committed lockfiles already
  pinned, and `git diff --exit-code -- package-lock.json client/package-lock.json` returned 0,
  proving neither lockfile moved.
- Notices required: none.

## Clean-Room Boundary

Confirmed. There is no runtime import from the V2 filesystem, because FND-001 added no runtime
code at all — no file under `server/`, `client/`, or `data/` was created or modified. The
`server/modern-src/` boundary that will eventually consume adapted V2 code is owned by `FND-003`
and does not yet exist.

The first opportunity for a clean-room violation is FND-003. The rule it must satisfy is already
recorded in the plan: V1 Express adapters import generated ESM from `server/modern-runtime/` only,
never a V2 source path.
