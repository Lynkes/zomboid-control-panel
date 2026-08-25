# Modernization Fixture Manifest

| Fixture ID | Description | Source path | Expected normalized snapshot | Expected parity report | SHA-256 | Secret-safe review |
| --- | --- | --- | --- | --- | --- | --- |
| FX-001 | Empty first-run DB | `server/tests/fixtures/modernization/fx-001-empty.json` | `...expected.json` | `...parity.json` |  | pending |

## Naming

- Input: `fx-<nnn>-<slug>.json`
- Expected normalization: `fx-<nnn>-<slug>.expected.json`
- Expected parity: `fx-<nnn>-<slug>.parity.json`

Every fixture is synthetic or explicitly scrub-reviewed. No reusable secret, real token, password hash, recovery hash, IP identity, or user path is permitted.
