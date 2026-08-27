import '@testing-library/jest-dom'
import './i18n'
import { configure } from '@testing-library/react'

// waitFor()'s own real-wall-clock timeout (@testing-library/dom's
// asyncUtilTimeout, stock default 1000ms) is the sibling vite.config.ts's
// testTimeout=60000 decision missed -- an identical exposure to the same
// CPU contention this floor commonly runs several concurrent agents and
// dev tooling under (see that file's comment for the reproduction), one
// layer down, inside every individual waitFor() call across 12 files and
// 30+ call sites instead of at the whole-test level. This mirrors that
// exact decision rather than adding new slack: a query that never finds
// its target still fails at this ceiling, it just isn't falsely blamed on
// contention first.
//
// bug-hunt-2026-08-26 (client-suite-flaky-one-in-six): demonstrated the
// mechanism directly -- with asyncUtilTimeout set too tight relative to a
// genuine async update, waitFor() produces a completely generic
// "Expected X, Received Y" assertion error with no hint that timing was
// involved, which is why a contention-induced failure's real cause is easy
// to miss. A timeout AFTER this change is a real bug to investigate, never
// something to explain away as "just needs a bigger number."
configure({ asyncUtilTimeout: 60000 })
