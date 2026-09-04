# Kevin's French + Usability Review — Access Control (Users, Sign-in/OIDC, Roles & Permissions)

Independent review of the three screens Angela built and verified herself tonight, per god's
request: an author reads what they meant, so these needed a second reader. Locale coverage is
numerically complete (users 41/41, oidcSettings 38/38, roles 133/133) — this is about whether the
French says the right thing, and whether the screens are honest and usable for a first-time French
operator, not about missing keys.

Method: read every string in `client/src/locales/fr/{users,oidcSettings,roles}.json` against its
English counterpart and against the actual server behaviour it describes (not just "does it read
naturally in French" — whether the CLAIM is true). Traced every claim back to the server code that
makes it true or false. Where a claim's truth wasn't obvious from reading, forced it: for the
seeded-role finding below, I didn't infer from the code shape — I called the actual function against
a real seeded-role record and watched what happened. No live browser session this pass (see "Not
reached"); this is a source-level review, same as how god closed a task earlier tonight from
source-reading alone.

Boundaries respected: report only, nothing fixed. All three pages are Angela's; the two files behind
Finding 1 (`server/services/permissions.js`, `server/routes/permissions.js`) aren't mine either.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `1594548` ("fix(permissions): deleteRole() refuses
> seeded roles outright, independent of member count"). `permissions.js`'s `deleteRole()` now
> throws `ROLE_IS_SEEDED` (403, "Built-in roles cannot be deleted.") as its very first check, before
> the member/reassignment logic. The fix commit's own comment cites this finding by name and file.
> Verified directly by reading current source (`permissions.js:743-754`).

**status: FIXED** — re-verified 2026-09-02, HEAD `5f913567`. `commit 1594548` confirmed still an ancestor of HEAD.

## FINDING 1 (High — this is a security/data-integrity gap, not a wording issue): "Les rôles intégrés ne peuvent pas être supprimés depuis cet écran" is true only of the button — nothing on the server enforces it

**WHERE:** `client/src/locales/fr/roles.json` `matrix.deleteSeededTooltip`, describing the disabled
delete button in `client/src/pages/RolesPermissions.tsx:457-467`. The actual gap is in
`server/services/permissions.js`'s `deleteRole()` (~line 663) and `server/routes/permissions.js`'s
`DELETE /roles/:id` (~line 67), neither of which check `role.isSeeded` anywhere.

**WHAT HAPPENS:** The French text is carefully scoped — "ne peuvent pas être supprimés **depuis cet
écran**" (cannot be deleted **from this screen**), not "cannot be deleted, period." Read narrowly,
it's technically true: the button is disabled. But nothing else backs that claim up. `deleteRole()`
never checks `isSeeded` — it checks whether the role has members (asks for a reassignment target if
so) and checks the recovery-lockout invariant, and that's the complete list of refusals. A seeded
role with zero current members — "admin" after every admin account has been moved to a custom role,
or a fresh install's "moderator"/"technician" before anyone's assigned them — can be deleted via
`DELETE /api/permissions/roles/:id` by anyone holding `roles.manage`, no different from any custom
role. The route itself has no additional check either.

**HOW I KNOW (forced, not inferred):** wrote a throwaway proof (mocked `database/init.js`, a single
seeded role `{id:"role-admin", name:"admin", isSeeded:true, capabilities:[...]}` with zero members)
and called `deleteRole("role-admin", {})` directly. Result: `{"deleted":true,"reassigned":0,...}`,
and the role was genuinely gone from the store afterward. Ran it, watched it happen, deleted the
scratch file — not shipped, these files aren't mine.

**WHY THIS MATTERS BEYOND "the French should say something else":** the operator-facing claim
creates the impression of a real protection ("built-in roles can't be deleted" is what a reader
takes away, regardless of the "from this screen" qualifier most people will skim past), when the
actual protection is a single disabled attribute in one React component. Any direct API call, any
future UI regression that re-enables the button, or any other client integration against this API
can permanently delete the "admin" role DEFINITION itself — not just remove members from it — with
no server-side refusal at all. Given how much of tonight's work went into recovery-lockout
protection specifically to prevent an admin-capability wipeout, this is a real gap in the same
threat model that protection was built for, just reached a different way (deleting the role
definition rather than removing the last holder's capability).

**WHAT SHOULD HAPPEN:** `deleteRole()` should refuse `isSeeded` roles outright (a plain, honest
error), independent of member count or the button's disabled state — matching what the text already
promises. This is the fix I'd want if I owned `services/permissions.js`; I don't, so I'm reporting
it rather than writing it.

**Severity: High.** Zero exploitation difficulty (one DELETE call, no special conditions beyond
`roles.manage` — which several tonight's-work custom roles could plausibly hold without also holding
`users.manage`), and the blast radius is losing the "admin" role definition entirely — worse than
losing access, since a role that doesn't exist can't be reassigned back either.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `d5e8bce` ("Fix three Kevin-review findings on
> Users/Sign-in/Roles..."). All three screens now `import { getUserErrorMessage } from
> '@/lib/errorMessage'` and route every catch-all fallback and initial-load error through it
> (confirmed 13 call sites across Users.tsx/OidcSettings.tsx/RolesPermissions.tsx). The local
> `describeError()` is gone from all three files. A `toasts.unknownError` fallback key was added to
> each locale file for the true-no-message case. Verified by reading current source.

**status: FIXED** — re-verified 2026-09-02, HEAD `5f913567`. `commit d5e8bce` confirmed still an ancestor of HEAD.

## FINDING 2 (Medium, systemic across all three screens): every unhandled error shows raw English, via three independently-reimplemented copies of the exact bug Toby already filed for `errorMessage.ts`

**WHERE:** `Users.tsx:117-119`, `OidcSettings.tsx:90-92`, `RolesPermissions.tsx:147-149` — each
defines its own identical local `describeError(error)`:
```ts
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
```
Used as the fallback in every catch block that doesn't special-case a specific `error.code` (and
several catch blocks special-case none at all). Also: all three screens' initial-load failure state
(`loadError`/`usersLoadError`) passes the raw message straight into `EmptyState`'s `description`
prop, unconditionally — no code lookup attempted at all, not even a fallback path.

**WHAT HAPPENS:** In French, a network failure, a generic 500, or any server error whose code isn't
one of the two or three specifically handled per screen (`ROLE_LOCKOUT_LAST_MANAGER`,
`USER_SELF_DELETE_REFUSED`, `ROLE_NAME_TAKEN`, `ROLE_HAS_MEMBERS`) shows its raw English `.message`
verbatim in a French-chrome toast, form error, or empty-state description. On the roles screen this
can even be a mixed-language sentence: `userCreatedRoleAssignFailedDescription` is a fully French
template with `{{reason}}` interpolated from `describeError(error)` — half the sentence in French,
the error clause in raw English.

**HOW THIS RELATES TO the already-filed bug:** Toby found this exact failure mode in
`client/src/lib/errorMessage.ts`'s `getUserErrorMessage()`, used by ServerConfig/Events/Dashboard.
**None of these three screens call that helper at all** — each reimplemented its own version of the
same "just show `.message`" shortcut independently, which means fixing `errorMessage.ts` will not
fix any of these three screens. This is the same bug class recurring by convergent implementation,
not a shared root cause — worth knowing before anyone assumes fixing the one helper closes this out
everywhere.

**Severity: Medium.** Not a security issue, but it's the exact "translation exists in intent but the
code path bypasses it" pattern from earlier tonight, now confirmed present in three more screens,
including the two newest ones (Users, OIDC) that didn't exist when the original bug was filed.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `d5e8bce` (same commit as Finding 2). Current field
> order (`OidcSettings.tsx:71`, `FIELD_KEYS`) is `issuerUrl, clientId, redirectUri, scope,
> providerName` for the tab-order constant, but the RENDERED layout (lines 332-399) is Issuer URL,
> then Redirect URI (with its confirm note), THEN Client ID/Client Secret — Redirect URI now
> appears before Client ID/Secret on screen, matching what a first-time operator needs. Verified by
> reading the current JSX render order directly, not just the constant.

**status: FIXED** — re-verified 2026-09-02, HEAD `5f913567` (same commit `d5e8bce` as Finding 2).

## FINDING 3 (Medium, usability — OIDC setup order): Client ID and Client Secret are asked for before the Redirect URI, but a first-time operator needs the Redirect URI *first*

**WHERE:** `client/src/pages/OidcSettings.tsx:217-318` — field order top to bottom: Issuer URL,
Client ID, Client Secret, Display name, **then** Redirect URI, then Scope.

**WHAT HAPPENS:** Setting up OIDC with any real provider (Google, Okta, Authentik, Keycloak, Auth0)
follows one universal order: you register a new application with the provider, which **requires**
supplying the redirect/callback URI as part of registration, and the provider only **then** issues a
Client ID and Client Secret for that registration. A true first-timer working top-to-bottom through
this form hits "Client ID" before they have one to enter, because they haven't registered anything
with their provider yet — and they can't, because the one piece of information their provider needs
first (the Redirect URI) is presented fifth, not first.

**WHY THIS IS A REAL FIRST-TIMER PROBLEM, not just field-order taste:** god's brief specifically
asked whether a first-time French-speaking operator can configure OIDC without knowing what a
redirect URI is — the panel's own design already answers "yes" for the URI ITSELF (it's
auto-suggested and one click both fills the field and copies it, so the operator never has to
construct or understand the value). But the auto-fill doesn't help if the operator doesn't reach it
until after getting stuck on a field they can't fill in yet. Moving the Redirect URI block to
directly after (or even before) Issuer URL would match the order operators actually need to work in.

**Severity: Medium.** Doesn't block a determined operator (they can scroll down, or already know the
OAuth dance from experience elsewhere), but works directly against the explicit goal of this screen
being usable by someone who has never done this before.

---

> **RECONCILED 2026-08-24 (fork):** FIXED at `d5e8bce` (same commit as Findings 2-3). A new
> `fields.redirectUriConfirmNote` string was added (en/fr) and is rendered directly under the
> suggested Redirect URI field (`OidcSettings.tsx:376`), asking the operator to confirm the
> suggestion matches the address they actually reach the panel on — exactly the mitigation this
> finding recommended (the underlying `req.protocol`/trust-proxy mechanism itself is unchanged, this
> fixes it via the honesty-note path the finding explicitly offered as the practical option since a
> code-level fix isn't possible without knowing the operator's real deployment). Verified by reading
> current source.

**status: FIXED (mitigation, not the underlying trust-proxy mechanism)** — re-verified 2026-09-02, HEAD `5f913567` (same commit `d5e8bce`). The confirm-note honesty-path mitigation is in place; `req.protocol`'s trust-proxy dependency itself is unchanged by design (no code fix possible without knowing the operator's deployment).

## FINDING 4 (Medium, correctness — not a translation bug, but the French help text doesn't warn about it): the auto-suggested Redirect URI can be silently wrong for the most common self-hosted deployment shape

**WHERE:** `server/routes/oidc.js:254` —
`` suggestedRedirectUri: `${req.protocol}://${req.get("host")}/api/auth/oidc/callback` ``

**WHAT HAPPENS:** `req.protocol` reflects the connection Express itself sees, not what the browser
used, unless Express's `trust proxy` setting is on. `server/index.js:257-275` confirms `trust proxy`
is **off by default**, opt-in only via a `TRUST_PROXY` env var. An operator running this panel behind
a reverse proxy doing TLS termination (nginx, Caddy, Traefik — a very common way to expose a
self-hosted panel to a real identity provider, since most providers require `https://` redirect
URIs) who hasn't separately set `TRUST_PROXY` will get a suggested URI starting `http://` when the
real public one needs to be `https://`. Clicking "Utiliser et copier" (`fields.useAndCopy`) pastes
that wrong value straight into both the panel's own field and the clipboard — nothing on screen
indicates the suggestion might not match what the browser's own address bar shows.

**HOW I KNOW:** read the exact derivation and confirmed `trust proxy` is opt-in, not default, in
`server/index.js`. Did not reproduce this against a live reverse proxy (no throwaway server stood up
this pass — see Not reached) — this is a traced-through-the-code finding, not a forced one, and I'm
marking it as such rather than overstating confidence.

**WHY IT'S IN SCOPE for a French/usability review and not just a server bug report:** the help text
(`fields.redirectUriHelp`, `"Collez cette URL exacte dans l'enregistrement..."`) tells the operator
to paste the suggested value **exactly**, with no caveat that it might not match their real public
URL. A first-timer trusting that instruction, behind a typical reverse-proxy setup, could get an
OIDC login that fails at their provider with a redirect_uri mismatch and no clue why — exactly the
kind of silent-wrong-behaviour god asked me to prioritize on the earlier adversarial pass, showing up
again here in a different screen.

**Severity: Medium** — real but conditional (only affects the reverse-proxy-without-TRUST_PROXY
case, which I'd guess is common but haven't measured), and not something the French text alone can
fix; would need either a browser-side URL check or a note when `window.location.protocol` disagrees
with the suggested value.

---

## Chased and ruled out (recording so nobody re-spends time on these)

- **Priority 1's own example, applied to user deletion:** "Supprimer" is used for the user-delete
  action (`deleteDialog.confirm`: "Supprimer le compte"). Checked its weight against every other
  `Supprimer` in the app (backups, chunks, mods, scheduled tasks, spawn regions, templates, roles) —
  all of them are genuinely permanent-deletion actions, none use it for anything softer (archiving,
  disabling, hiding). Reusing it for user deletion is consistent, not weaker-or-stronger than the
  action it names.
- **Capability-label distinctness (the matrix at ~28 rows, not quite 27 by my count but close):**
  read every capability label and every group header for literal duplicates across French. None
  found. The one near-collision — "Intégration PanelBridge" (group) vs "Intégrations" (a different
  group, Discord/webhooks) — is inherited directly from the English source (`permissions.js`'s own
  `group: "PanelBridge Integration"` / `group: "Integrations"`), not introduced by translation; not
  filing it as a French bug, since fixing it would mean renaming the underlying English taxonomy.
- **`confirmSelfCapabilityLoss.description`'s claim ("you'll keep all your other current
  permissions")**: verified `handleToggleCapability` always toggles exactly one capability per
  confirmation (one checkbox = one array add/remove) — the claim is accurate for every reachable
  case, no batch-edit path that could make it false.
- **"La connexion locale continue toujours de fonctionner"** (local sign-in always keeps working):
  grepped the whole auth path for anything that could disable password login when OIDC is
  configured — nothing does. True as stated.
- **`toasts.testSuccessDescription`'s scope** ("the panel could reach the provider and read its
  configuration"): read `testOidcDiscovery()` — it calls the `openid-client` library's `discovery()`
  with the issuer URL, client ID and secret, but that call fetches the provider's `.well-known`
  metadata; it does not perform an actual token exchange, so a wrong client secret would NOT make
  this test fail. The French text is carefully scoped to "reached + read config," not "your
  credentials are valid" — an accurate, appropriately narrow claim, not an overclaim. Worth noting
  as a good example, not just an absence of bugs.
- **`status.notConfiguredHint`'s claim** ("fill in the fields below and save to activate it" — no
  mention of needing a restart): true, and I know this one first-hand — I built and verified the
  `resetOidcConfigCache()` fix earlier tonight specifically so a saved OIDC change takes effect
  immediately without a restart.
- **The delete-user dialog's "next request, not eventually" claim**: per god's own instruction, this
  was already proven true earlier tonight with a real signed token; not re-filing it.

## Not reached

- **No live browser/French click-through this pass** — this review is source-level (every string
  traced to the server behaviour that makes it true or false), not a driven session against a real
  running instance. If a live pass is wanted, Finding 4 in particular (the reverse-proxy redirect-URI
  case) would benefit from actually reproducing it against a throwaway proxy setup rather than
  reasoning from `trust proxy`'s default alone.
- **Settings' deeper tabs, and any Access-Control-adjacent copy outside these three screens'
  own locale files** (e.g. the nav labels, sidebar section header) — out of scope for this specific
  ask, not reviewed.
- **The `openid-client` library's actual behaviour on a real provider** — Finding 4's "does discovery
  validate credentials" conclusion is read from this codebase's call shape, not verified against the
  library's own test suite or documentation; flagging the confidence level rather than overstating it.
