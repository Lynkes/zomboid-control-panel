// RETIRED, 2026-08-26 bug hunt -- no longer wired into vitest.config.js.
//
// This file used to mint ONE temp dataDir/paths.config.json for the entire
// `vitest run` invocation (see docs/modernization/DECISIONS.md, DISC-001,
// for why it existed at all: keeping test runs off the repo's real data/
// and off each other's paths.config.json when several agents run the suite
// concurrently). That per-RUN sharing turned out to be the root cause of a
// separate, worse problem: every test file that imports the real, unmocked
// database/init.js got its own in-memory snapshot of the SAME physical
// db.json (vitest's default isolate:true resets the module registry per
// file, not the file on disk), and every one of them could silently
// overwrite every other's committed data with no lock or merge -- proven to
// cause both false failures and false passes under parallel file execution.
//
// Replaced by server/tests/vitest.perFileDataDir.setup.mjs, a `setupFiles`
// entry that gives every test FILE its own temp root instead of the whole
// run sharing one. See that file's header for the full mechanism and why a
// setupFiles hook (once documented here as "too late") is actually the
// right tool for a per-file scope, as opposed to this file's original
// per-run scope.
//
// Kept in place, inert, rather than deleted: docs/modernization/DECISIONS.md,
// RISK_REGISTER.md, WORK_PACKAGES.md and the FND-005 evidence files all name
// this exact path as part of a tracked work package (DISC-001/FND-005) owned
// outside tonight's bug hunt. Deleting it would leave those records pointing
// at a path that no longer exists; retiring it in place leaves an explanation
// for whoever reads it from there next. Not this session's call to edit that
// documentation itself.
export async function setup() {}
export async function teardown() {}
