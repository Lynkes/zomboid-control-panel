# API Contract Inventory Format

Group records by V1 route file. One row per route.

| Method/path | Handler | Auth/role | Limiter | Request | Success | Errors | Side effects | Socket events | Client consumers | Fixture |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Fixture Convention

```text
server/tests/contract-fixtures/<route-file>/<method-lower>-<path-slug>/
  request.json
  response.success.json
  response.<status>-<code>.json
  headers.json
  socket-events.json
  normalization.json
```

Path slug replaces `/` with `-` and parameter names with their semantic name. Example: `put-servers-id`.

## Capture Requirements

- Record status, content type, relevant headers, response shape, null/optional behavior, and event order.
- Replace nondeterministic values only through `normalization.json`.
- Replace secrets with typed placeholders before disk write.
- Link `client/src/lib/api.ts` method and every page/extension/updater consumer.
