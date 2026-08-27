/**
 * The 2026-08-26 errorMessage.ts coverage audit found `getUserErrorMessage()`
 * (client/src/lib/errorMessage.ts) imported by only 6 of 22 pages -- the
 * other ~100+ call sites show a caught error's raw `.message` directly in a
 * toast or an inline error state, discarding any translated text and any
 * recovery link a registered error code would otherwise provide. Converting
 * the existing sites doesn't stop the 101st one someone writes next week;
 * this rule is the structural half.
 *
 * THREE SYNTAXES FOUND SO FAR, NOT ONE -- each found from a real site, each
 * time after the previous count had already been treated as complete:
 *   1. `x instanceof Error ? x.message : fallback` (isSameErrorMessageTernary)
 *   2. `x?.message || fallback` / `x.message || fallback` (isRawMessageLogicalOr,
 *      found by Kevin converting Mods.tsx -- the ternary-only count from the
 *      original audit was correct for shape 1 and silent about this one)
 *   3. a bare `x.message` / `x?.message` with NO fallback at all
 *      (isBareErrorMessageAccess, found sweeping ChunkCleaner.tsx for a third
 *      shape after god asked whether one existed -- worse than shapes 1/2
 *      since an empty/undefined .message shows nothing at all, not even a
 *      generic fallback)
 * A rule matching only a subset would have DECLARED A FILE CLEAN while the
 * others kept getting written -- worse than no rule, since a green lint gate
 * is a positive claim the pattern is gone. Treat the true population of
 * "a caught error's raw message reaches the user outside getUserErrorMessage()"
 * as LARGER than these three shapes catch, not as fully enumerated by them --
 * this is what's been found so far, not a closed set. If a fourth turns up,
 * add it here rather than assuming three is now complete either.
 *
 * THREE KINDS OF GAP FOUND SO FAR, ON DIFFERENT AXES.
 * "How far the rule traces, part 1" -- CLOSED (Jim, 2026-08-27), NOT
 * theoretical after all: the two-step `const msg = <shape>; toast({
 * description: msg })` was carried in this file's own comment as "accepted,
 * no currently-actionable site found" -- wrong. ServerFinder.tsx's
 * fetchServers() shipped exactly this shape live (fixed 7bfd32d, found by an
 * unrelated verification pass, NOT by this rule), and a dedicated sweep for
 * the same pattern afterward found four more: Servers.tsx:1014,
 * WorldMap.tsx:2494/2600/2653. A ONE-HOP variable-flow check now closes
 * this -- see checkVariableFlowGap below for the mechanism and its own
 * still-open limit (a two-HOP chain through a helper function, ServerSetup.tsx's
 * shape, is a known, separate, NOT-closed gap; see that function's comment).
 * "How far the rule traces, part 2" (still accepted, no currently-actionable
 * site found): the ternary only matches a bare `instanceof Error`, not an
 * `instanceof ApiError` or other subclass (2026-08-26 self-audit: exactly one
 * site in the whole client matches that shape, and it was ALSO two-step, so
 * it's now caught by the fix above without needing this widened separately --
 * re-checked 2026-08-27, still true, still zero-actionable on its own).
 * "Where the rule looks" (Jim, 2026-08-26, WITH live sites): the sink check
 * below only recognised `toast(...)`/`set*(...)` call arguments -- it never
 * entered a JSX expression container at all, so `{error.message}` rendered
 * straight into markup was structurally invisible. Two real instances,
 * ErrorBoundary.tsx:56 and FeatureErrorBoundary.tsx:89 -- the app's own crash
 * screens, both spelling their caught error as `this.state.error.message`
 * (a class component has no bare local variable to catch into), which also
 * needed isBareErrorMessageAccess's object check widened from "bare
 * identifier" to "chain ending in an error-like property" (isErrorLikeReference)
 * -- the JSX gap alone wasn't sufficient to catch these two without that.
 * Live evidence is what changes the calculus versus an accepted gap: a
 * demonstrated site earns the fix; a theoretical one doesn't -- and the
 * lesson from part 1 above is that "no currently-actionable site found" is a
 * claim about a search's own coverage, not a permanent fact about the code.
 *
 * All three (now four) shapes are flagged ONLY when feeding a value a user
 * will actually see: the direct argument to `toast(...)`, or the direct argument to a
 * `set...(...)` state-setter call (including the `setX(prev => ({ ...prev,
 * error: <node> }))` functional-update shape real sites used). This is
 * deliberately narrower than "any of these shapes anywhere" -- the audit's
 * own findings ("bucket C") show some uses are legitimate (errorMessage.ts's
 * own getRecoveryUrl() builds the ternary shape to pattern-match against,
 * not to display; client-errors.ts builds it for a diagnostic payload sent
 * to the server, where the raw text is exactly what you want; `result.message`
 * / `data.message` read a normal API response field, not a caught error, and
 * are common enough that shapes 2 and 3 restrict their identifier to common
 * error-variable names below rather than matching any `.message`). Scoping
 * to the two real sinks catches every genuine display site while leaving the
 * legitimate uses alone with no file-level exemption needed -- none of them
 * is a toast()/set*() argument.
 *
 * UPDATE 2026-08-27: the two-step limitation this paragraph used to
 * describe as accepted is now CAUGHT (see checkVariableFlowGap and the
 * VariableDeclarator visitor below) -- five real sites were found using it.
 * Remaining known limitation, still accepted: a TWO-hop chain through an
 * intermediate function call (`const raw = <shape>; const msg =
 * helper(raw); toast({ description: msg })`, ServerSetup.tsx's real shape)
 * is still not caught -- see checkVariableFlowGap's own comment for why.
 *
 * THE FIX IS THE SAME CALL EVERYWHERE, INCLUDING "BUCKET C" SITES: replace
 * any of the three shapes with `getUserErrorMessage(error, fallback)`. That
 * function already falls through to the identical raw message when no error
 * code matches (see its own body), so a self-contained-validation-text site
 * with no code and no sensible recovery link (the audit's "bucket C") shows
 * byte-identical text either way -- there is no real site found where any
 * raw shape is actually better. A genuinely exceptional site that needs the
 * old raw behavior on purpose should call errorMessage.ts's
 * `rawErrorMessageIntentional(error, fallback)` instead of eslint-disabling
 * this rule -- same behavior, but the exemption is a named, greppable
 * function call in the diff, not a comment that hides the decision. That
 * call doesn't match any of the three shapes below, so this rule's selectors
 * don't match it -- no separate file-level exemption is needed for it.
 */

// Real error-catch variable names seen across this codebase for shape 2
// (`x.message || fallback`), which has no structural signal as strong as
// shape 1's `instanceof Error` check -- `result.message`, `data.message`,
// `res.message`, `backupProgress.message` etc. are common, legitimate reads
// of a normal API response/progress payload field, not a caught error, and
// must not be flagged. This is a heuristic, not a closed set: a caught
// error bound to a name outside this list is a known blind spot, same
// category as the two-step-assignment limitation above.
const ERROR_LIKE_IDENTIFIER_RE =
  /^(?:err|error|e|ex|exception|apiErr|caughtError|thrownError)$/i;

function unwrapChain(node) {
  return node && node.type === "ChainExpression" ? node.expression : node;
}

function isMessageMemberOf(node, objectName) {
  const member = unwrapChain(node);
  if (!member || member.type !== "MemberExpression") return false;
  if (member.property.type !== "Identifier" || member.property.name !== "message") {
    return false;
  }
  if (member.object.type !== "Identifier") return false;
  return objectName === undefined || member.object.name === objectName;
}

// Shape 1: `x instanceof Error ? x.message : fallback`.
function isSameErrorMessageTernary(node) {
  if (node.type !== "ConditionalExpression") return false;
  const { test, consequent } = node;
  if (test.type !== "BinaryExpression" || test.operator !== "instanceof") {
    return false;
  }
  if (test.left.type !== "Identifier" || test.right.type !== "Identifier") {
    return false;
  }
  if (test.right.name !== "Error") return false;

  return isMessageMemberOf(consequent, test.left.name);
}

// Shape 2: `x?.message || fallback` / `x.message || fallback`, x restricted
// to a common error-variable name (see ERROR_LIKE_IDENTIFIER_RE above).
function isRawMessageLogicalOr(node) {
  if (node.type !== "LogicalExpression" || node.operator !== "||") return false;
  const member = unwrapChain(node.left);
  if (!member || member.type !== "MemberExpression") return false;
  if (member.property.type !== "Identifier" || member.property.name !== "message") {
    return false;
  }
  if (member.object.type !== "Identifier") return false;
  return ERROR_LIKE_IDENTIFIER_RE.test(member.object.name);
}

// True for `error` (bare identifier matching the error-like list) or for
// a chain ending in an error-like property -- `this.state.error`,
// `this.props.error` -- which is how a class-component error boundary
// necessarily spells its caught error (there is no bare local variable to
// name). One level of "what is this chain's own last segment called" is
// enough for every real site found; not a general is-this-an-Error-typed
// walk.
function isErrorLikeReference(node) {
  if (node.type === "Identifier") return ERROR_LIKE_IDENTIFIER_RE.test(node.name);
  if (node.type === "MemberExpression" && node.property.type === "Identifier") {
    return ERROR_LIKE_IDENTIFIER_RE.test(node.property.name);
  }
  return false;
}

// Shape 3: a bare `x.message` / `x?.message` with no fallback at all --
// worse than shapes 1/2 (an empty or undefined .message shows nothing,
// not even a generic string), same identifier restriction as shape 2
// (now also matching a `this.state.error`-shaped chain -- see
// isErrorLikeReference -- found in the two class-component error
// boundaries, which have no bare local variable to catch into).
// Visited directly as MemberExpression: espree/typescript-eslint parse
// `x?.message` as ChainExpression > MemberExpression, so the traversal
// reaches this exact node either way, optional or not.
function isBareErrorMessageAccess(node) {
  if (node.type !== "MemberExpression") return false;
  if (node.property.type !== "Identifier" || node.property.name !== "message") {
    return false;
  }
  return isErrorLikeReference(node.object);
}

// True when `node` (the ternary or the logical-OR expression) is the value
// a user-visible sink will receive: the sole/only argument of a `setXxx(
// ...)` call (directly, or through an implicit-return `prev => ({ ...prev,
// error: <node> })` functional updater -- the shape setCollectionStatus/
// setDepSearchData sites actually used), or a property value inside the
// object literal that is `toast(...)`'s argument. Walks a bounded ancestor
// chain rather than the whole function body -- every real site found is
// within this depth, this is intentionally shallow, not a general
// data-flow search.
function isFeedingUserVisibleSink(node) {
  let current = node;
  for (let depth = 0; depth < 8 && current.parent; depth += 1) {
    const parent = current.parent;

    // `{error.message}` rendered straight into markup -- found in
    // ErrorBoundary.tsx/FeatureErrorBoundary.tsx, the app's own crash
    // screens. A third sink alongside toast()/set*(), on a different axis
    // from the other two gaps this rule already documents as open (those
    // are about how FAR the rule traces; this is about WHERE it looks --
    // it never entered a JSX expression container at all).
    if (parent.type === "JSXExpressionContainer") {
      return true;
    }

    if (parent.type === "CallExpression" && parent.callee.type === "Identifier") {
      if (/^set[A-Z]/.test(parent.callee.name) && parent.arguments.includes(current)) {
        return true;
      }
      if (parent.callee.name === "toast" && parent.arguments.includes(current)) {
        return true;
      }
    }

    // Keep walking through the Property -> ObjectExpression chain that both
    // `toast({ description: <node> })` and a nested functional-update object
    // (`{ ...prev, error: <node> }`, possibly nested again under a computed
    // key) produce.
    if (
      parent.type === "Property" ||
      parent.type === "ObjectExpression" ||
      parent.type === "ChainExpression"
    ) {
      current = parent;
      continue;
    }

    // `setX(prev => ({ ...prev, error: <node> }))` -- an implicit-return
    // arrow function body sits between the object literal and the set*()
    // call it's the sole argument of.
    if (parent.type === "ArrowFunctionExpression" && parent.body === current) {
      current = parent;
      continue;
    }

    return false;
  }
  return false;
}

// Finds `name` in `scope` or any enclosing scope -- a plain lexical lookup,
// not full data-flow: this is deliberately only strong enough to resolve a
// `const`/`let` declarator's own binding from where it was declared, the
// single relationship the ONE-HOP check below needs.
function findVariableInScope(scope, name) {
  let current = scope;
  while (current) {
    const found = current.variables.find((v) => v.name === name);
    if (found) return found;
    current = current.upper;
  }
  return null;
}

// ONE-HOP variable-flow check (2026-08-27): closes the two-step gap this
// rule used to document as "accepted, no currently-actionable site found" --
// `const msg = <shape>; toast({ description: msg })`. That claim turned out
// to be wrong: ServerFinder.tsx's fetchServers() shipped exactly this shape
// live (fixed 7bfd32d, found by a verification pass, not by this rule) and a
// sweep for the same pattern afterward found four more (Servers.tsx,
// WorldMap.tsx x3), all `const msg = <shape>; toast({ description: msg })`
// or `... err.message : fallback` one binding away from a direct-argument
// toast()/set*() call.
//
// Deliberately ONE hop, not a general data-flow search, same philosophy as
// isFeedingUserVisibleSink's own bounded ancestor walk: for a `const`/`let`
// declarator whose init matches one of the three raw shapes, look up the
// declared variable and check whether ANY read reference of it is itself
// feeding a sink (reusing isFeedingUserVisibleSink unchanged, just started
// from the reference's identifier instead of the shape node). A `var` is
// skipped -- this doesn't reason about reassignment across branches, and
// every real site found used const/let. A variable used ONLY as a
// comparison operand (Setup.tsx's `message === 'SETUP_TOKEN_REQUIRED' ? ... :
// getUserErrorMessage(...)`) is correctly left alone: isFeedingUserVisibleSink
// only recognizes specific sink-shaped ancestors, and a BinaryExpression
// comparison isn't one of them.
//
// STILL NOT CAUGHT, same "one hop" reasoning why: `const raw = <shape>; const
// msg = helper(raw); toast({ description: msg })` -- ServerSetup.tsx's real
// shape, which routes the raw text through installationErrorGuidance() before
// display. Catching that needs tracing an arbitrary function's own return
// value back to its parameter, a genuinely different (and much larger) class
// of analysis than "does this exact binding's own reference feed a sink" --
// left as a known, named gap rather than chased, same disposition this file
// already gives its other accepted limitations.
//
// Deferred to Program:exit rather than checked inline in the
// VariableDeclarator visitor: ESLint sets a node's `.parent` when it is
// ENTERED during the main traversal, in document order -- a reference that
// occurs LATER in the same block (the toast() call after the const) has not
// been entered yet, and so has no `.parent`, at the point a VariableDeclarator
// visitor for an EARLIER statement would run. Collecting candidates during
// the main pass and walking their references only after the whole file has
// been traversed (Program:exit) guarantees every reference's ancestor chain
// is fully linked before isFeedingUserVisibleSink ever walks it.
function checkVariableFlowGap(context, candidateDeclarators) {
  for (const declarator of candidateDeclarators) {
    const scope = context.sourceCode.getScope(declarator);
    const variable = findVariableInScope(scope, declarator.id.name);
    if (!variable) continue;

    const feedsASink = variable.references.some(
      (reference) =>
        reference.identifier !== declarator.id &&
        reference.isRead() &&
        isFeedingUserVisibleSink(reference.identifier),
    );
    if (feedsASink) {
      context.report({ node: declarator.init, messageId: "rawMessage" });
    }
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow showing a caught error's raw .message directly (via a ternary or a `|| fallback`) in a toast or error state; use getUserErrorMessage() so a registered error code's translation and recovery link aren't silently discarded",
    },
    schema: [],
    messages: {
      rawMessage:
        "This shows the raw, untranslated error text directly, discarding any translated message or recovery link getUserErrorMessage() (lib/errorMessage.ts) would provide for a coded error -- and it behaves identically to that call when no code exists, so there's no downside to switching. If this is a genuinely exceptional site where the raw behavior is intentional, call rawErrorMessageIntentional(error, fallback) (also in lib/errorMessage.ts) instead of this expression to make that exemption explicit.",
    },
  },

  create(context) {
    const candidateDeclarators = [];

    return {
      ConditionalExpression(node) {
        if (!isSameErrorMessageTernary(node)) return;
        if (!isFeedingUserVisibleSink(node)) return;
        context.report({ node, messageId: "rawMessage" });
      },
      LogicalExpression(node) {
        if (!isRawMessageLogicalOr(node)) return;
        if (!isFeedingUserVisibleSink(node)) return;
        context.report({ node, messageId: "rawMessage" });
      },
      MemberExpression(node) {
        if (!isBareErrorMessageAccess(node)) return;
        if (!isFeedingUserVisibleSink(node)) return;
        context.report({ node, messageId: "rawMessage" });
      },
      VariableDeclarator(node) {
        if (!node.init || node.id.type !== "Identifier") return;
        if (node.parent.type !== "VariableDeclaration" || node.parent.kind === "var") return;
        // isBareErrorMessageAccess expects an unwrapped MemberExpression --
        // the MemberExpression visitor above receives that directly because
        // ESLint's traversal reaches the inner node regardless of its
        // ChainExpression wrapper, but `node.init` here IS that wrapper for
        // an optional-chained `err?.message` and must be unwrapped first.
        const isShape =
          isSameErrorMessageTernary(node.init) ||
          isRawMessageLogicalOr(node.init) ||
          isBareErrorMessageAccess(unwrapChain(node.init));
        if (isShape) candidateDeclarators.push(node);
      },
      "Program:exit"() {
        checkVariableFlowGap(context, candidateDeclarators);
      },
    };
  },
};
