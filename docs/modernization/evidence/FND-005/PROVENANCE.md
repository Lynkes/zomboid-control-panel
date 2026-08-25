# V2 Source Provenance: FND-005

- V2 source repository: `D:\Projects\Zomboid_dev_panel V2`
- V2 source commit: **not applicable — no V2 source was read, copied, or adapted**
- V1 fork baseline: `8642dc467938a47ca8aac76fc44fc1875446c88b` (`v1.1.55`)

| V2 source path | Symbols/concepts used | Modernization target path | Ported/copied/adapted | Deliberate deviations | Tests |
| --- | --- | --- | --- | --- | --- |
| _none_ | _none_ | _none_ | _none_ | _none_ | _none_ |

**Nil return, stated explicitly** so that "no provenance" is distinguishable later from "provenance
not recorded".

The pattern used is not borrowed from V2 at all. It is lifted from **the modernization plan's own
performance-baseline step**, which already writes a temporary `paths.config.json` pointing at
`%TEMP%` and removes it in a `finally` block. FND-005 generalizes that established, in-repo pattern
to the test gate. Nothing was invented and nothing was imported.

## Dependency/License Review

- New dependencies: **none.** `vitest` and `vitest/config` were already present and already used.
- Lockfiles: untouched.
- Notices required: none.

## Clean-Room Boundary

Confirmed. Neither new file imports anything from the V2 filesystem or from
`D:\Zomboid_dev_panel\GitHub`. `vitest.config.js` imports only `vitest/config`; the global setup
imports only `node:fs`, `node:os`, `node:path`, and `node:url`.
