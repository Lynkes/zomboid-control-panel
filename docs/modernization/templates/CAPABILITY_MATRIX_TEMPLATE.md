# Target Capability Matrix

Cell format: `supported | mode | authority | reason`.

| Target/connector | lifecycle.start | lifecycle.stop | lifecycle.restart | rcon.execute | files.read | files.write | backup.create | workshop.scan | panelbridge.command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| local/direct |  |  |  |  |  |  |  |  |  |
| local/agent |  |  |  |  |  |  |  |  |  |
| remote/rcon |  |  |  |  |  |  |  |  |  |
| remote/sftp-rcon |  |  |  |  |  |  |  |  |  |
| provider-api |  |  |  |  |  |  |  |  |  |

Each row links to the machine-readable capability snapshot fixture and contract version. Unsupported cells require a stable reason code.
