# Modernization Rollback Index

This file is the program-level recovery entry point. Package-specific commands live in evidence rollback manifests.

| Domain/package | Feature flag | Last legacy authority | Candidate authority | Rollback manifest | Last rehearsal | Status |
| --- | --- | --- | --- | --- | --- | --- |

## Global Rules

- Disable modern reads/writes before file or data restoration.
- Never delete a failed modern SQLite DB automatically.
- Preserve failed DB/import/operation evidence for diagnosis.
- Restore V1 JSON authority and verify representative workflows.
- Tower rollback requires explicit user approval and deployment safety checks.
