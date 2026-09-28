# Security Policy

## Supported Versions

Security fixes are applied to the latest release and the `main` branch.

## Reporting A Vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private
security advisory flow for this repository, or contact the repository owner
through the email address shown on the owner's GitHub profile.

Include the affected version, a concise reproduction, impact, and any safe
mitigation. Please do not include live RCON passwords, JWT secrets, Steam
credentials, Discord tokens, or support bundles containing them.

## PanelBridge Steam Workshop Item

A server can get PanelBridge from the Steam Workshop item
`ZomboidControlPanelBridge` instead of having the panel copy it into the
game folder. Operators opt in per server; panel-installed stays the default.

- **One publishing account.** The item is published from a single
  dedicated Steam account. Whoever controls that account can publish Lua
  that every server using Workshop delivery runs after its next restart,
  and that every player who joins one of those servers downloads and runs.
  The publishing tool never takes a Steam password; steamcmd asks for it
  itself. Report a suspected compromise of the item or the account through
  the private flow above. An operator can switch a server back to
  panel-installed at any time in Settings → PanelBridge, which removes the
  item from its settings file.
- **The item id ships with each panel release.** It lives in
  `pz-mod/workshop/published.json`, is embedded in the executable builds,
  and is never fetched from the network, so a panel only points servers at
  the item its own release carries. The one override is the
  `PANEL_BRIDGE_WORKSHOP_ID` environment variable, for the maintainer's
  tests; it always marks the item as a preview in the panel.
- **What the Lua integrity check covers.** Workshop delivery lets an
  operator set `DoLuaChecksum=true` again. That turns the Lua integrity
  check back on: players whose Lua, script or animation files differ from
  the server's are refused. It doesn't stop modified game clients, and
  admin accounts skip this check.
