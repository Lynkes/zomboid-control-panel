# PRODUCT.md

## Who this is for

One person running a Project Zomboid dedicated server, almost always for a private group of
friends rather than a public playerbase. They are the operator, not necessarily a sysadmin — many
arrive here because the alternative is editing `.ini` files and typing raw RCON commands by hand.
The panel can manage more than one server ("Managed Servers" / fleet view exists in V1), but it is
still one operator managing servers they personally own, not a multi-tenant service for other
people's servers.

They are frequently running this **with the game open on a second monitor**, watching the same
world the panel is describing. The live World Map, right-click player actions (teleport, heal,
kick), and the dashboard's "one screen covers most of routine admin work" framing (V1's own
description) all assume the operator is cross-referencing the panel against what they can currently
see in-game, not reading it cold.

They are often mid-crisis when they open a given screen: a mod broke the server on update, a player
is griefing and others are waiting for a ban, the server crashed and needs a restart before people
lose patience. Confirmation copy, error messages, and empty states should assume the reader is
stressed and needs the actual next step, not just an acknowledgement that something went wrong.

## What this is NOT for

- **Not a general Linux/Windows server admin console.** It does not manage the host OS, other
  applications, or unrelated services. Scope stops at Project Zomboid and the panel's own process.
- **Not a multi-tenant or hosting-provider product.** No concept of separate customers/orgs each
  with their own servers. Multiple servers in one panel still belong to one operator.
- **Not built for a large ops team.** Roles/permissions exist (admin/technician/moderator-style
  capabilities) for a handful of trusted co-admins or moderators helping run the same community,
  not for org-chart-style access management.
- **Not a documentation surface for Project Zomboid admin commands in general.** It exposes the
  specific actions the panel implements (RCON passthrough, world map actions, mod management,
  backups, scheduling, Discord integration) — it is not a general PZ knowledge base.
- **Not assuming a reliable ops environment.** The server it manages can be offline, mid-restart,
  or unreachable at any moment (that's often *why* the operator opened the panel), and every screen
  needs to degrade honestly rather than assume happy-path connectivity.
