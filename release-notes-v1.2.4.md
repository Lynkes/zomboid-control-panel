# v1.2.4

## Fixed

- Scheduled backups no longer build an unbounded filesystem/archive queue on
  large Project Zomboid saves, preventing the packaged panel from exhausting
  the Node.js heap.
- Added regression coverage for nested archive completeness and bounded
  traversal.

## Release contents

- Rebuilt Windows and Linux binaries and release archives.
- Refreshed checksums and Docker installation assets.