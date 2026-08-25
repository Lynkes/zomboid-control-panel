## v1.2.2

### Fixed

- **Reverse-proxy requests could trigger `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`.** `TRUST_PROXY` now accepts a safe hop count, IP, subnet, or comma-separated IP/subnet list, with Docker and systemd examples. Invalid values fail closed. (#110)
- **World Map fallback zoom could stop at low resolution during temporary build-discovery failures.** The verified 42.20.0 fallback now keeps its level-22 ceiling, while sparse edge tiles still fall back to coarser tiles.
- **World Map bridge polling could overlap during large responses.** Player and vehicle/safehouse polling now uses single-flight gates to reduce duplicate work and memory pressure.
- **Windows server-state checks could confuse an empty successful process scan with a failed PowerShell probe.** The panel now invokes PowerShell explicitly, includes diagnostics, and fails closed on probe errors.
- **Windows packages could contain an LF-only `Start.bat`.** Release generation now writes CRLF line endings for reliable Windows execution.

### Downloads

- `ZomboidControlPanel-windows.zip` - Windows full package
- `ZomboidControlPanel-linux.tar.gz` - Linux full package
- `checksums.txt` - SHA256 verification hashes
