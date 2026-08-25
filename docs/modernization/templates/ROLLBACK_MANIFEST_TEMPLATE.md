# Rollback Manifest: <WP-ID>

- Feature flag:
- Pre-change SHA:
- Candidate SHA:
- Data authority before:
- Data authority after:

## Backups

| Artifact | Backup path | SHA-256 | Restore target | Verified |
| --- | --- | --- | --- | --- |

## Immediate Flag Rollback

```powershell
# Exact command/config change
```

Verification:

```powershell
# Exact command proving legacy path is active
```

## File/Binary Rollback

```powershell
# Exact restore command
```

## Data Rollback Rule

State restore, forward-fix, or preserve-for-forensics behavior. Never delete the modern DB automatically.

## Post-Rollback Verification

- [ ] Health endpoint
- [ ] V1 workflow smoke test
- [ ] Data authority confirmed
- [ ] No in-flight operations stranded
- [ ] Evidence captured
