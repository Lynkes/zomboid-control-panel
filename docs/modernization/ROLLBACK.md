# Modernization Rollback Index

This file is the program-level recovery entry point. Package-specific commands live in evidence rollback manifests.

| Domain/package | Feature flag | Last legacy authority | Candidate authority | Rollback manifest | Last rehearsal | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FND-001 (baseline/ledgers) | none — no runtime behavior | V1 `data/db.json` via lowdb | unchanged | `evidence/FND-001/ROLLBACK.md` | not rehearsed (would delete the evidence under review) | review |

No domain has a modern authority yet. Nothing on this table can strand data, because nothing on it
writes any.

## Global Rules

- Disable modern reads/writes before file or data restoration.
- Never delete a failed modern SQLite DB automatically.
- Preserve failed DB/import/operation evidence for diagnosis.
- Restore V1 JSON authority and verify representative workflows.
- Tower rollback requires explicit user approval and deployment safety checks.
