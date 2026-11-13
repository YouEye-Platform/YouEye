# Independent copy (not usable yet)

An independent copy would turn a cold disk copy of a box into a second, separate box: same local users and data,
but new machine identity, credentials and address. A raw VM clone is not this; two clones share secrets and
identities.

**Status.** Only the box-side phases exist in this repository. The outer coordinator (stop the source, copy its disk,
boot the copy in network quarantine, release it at the end) was never part of this repository and does not exist
now. No capability marker is advertised (`spine/internal/cmd/appliance_copy.go`), and no supported procedure uses
these commands. Treat them as unfinished.

## What is in the code

Hidden commands under `youeye appliance independent-copy` (`spine/internal/cmd/appliance_copy*.go`), backed by
`spine/internal/systemupdate/core_copy*.go` and the Control Panel's `control-panel/src/lib/copy/`. The mutating ones
read a root-owned request file.

| Command | Runs on | Does |
|---|---|---|
| `inventory` | source | lists the apps, resources and integrations the copy would need to handle; refuses unknown ones |
| `reserve-source`, `release-source` | source | take and release a lifecycle reservation on the source |
| `quiesce-source`, `restore-source` | source | record power and autostart state and stop the writers; restore them |
| `prepare-host` | copy | import the copied datasets; new machine ID, ZFS host ID and SSH host keys; fresh session, bridge, CLI and deployment secrets; new Incus server certificate and CP client certificate; drop the source MAC from the DHCP profile. Requires a reboot afterwards |
| `start-core` | copy | start the core containers with the new credentials; bind Pi-hole to the copy's address |
| `prepare-identity` | copy | YouEye ID: end all sessions and codes, rotate signing keys and client secrets, keep users, passwords and groups |
| `prepare-domain` | copy | replace the copied YouEye Names and TLS state with the copy's own Names bundle, then change the URL |
| `prepare-apps` | copy | give apps new installation IDs and credentials, keeping grants and data |
| `prepare-verify` | copy | check the platform phases |
| `commit` | copy | verify identity, a new boot, credentials, installed files, health, DNS and the served certificate; write the copy receipt |

Limits written into the inventory: only IPv4 DHCP hosts, standalone Incus, and the six native apps' layouts are
supported. Configured Pointer providers, SMTP, external DNS and app AI integrations are refused before anything is
stopped.

Copy receipts and the identity changes are covered by unit tests only; no copy has been accepted on real boxes.
