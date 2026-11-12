# Release Channels

Spine resolves updates from the release branch it was installed with (`--branch`/`--release-channel`). `youeye update self` and `youeye update control` fetch the latest tag for that branch, falling back to the `main` tag when no branch-specific tag exists.

Releases are unsigned for now. Every downloaded artifact is checked by sha256
and size against the accepted `core-release.json` (fetched over HTTPS; its exact
digest is recorded in protected State by the installer), or against the
channel's pinned digest. A missing digest or a mismatch fails closed.

| Channel | Meaning |
|---------|---------|
| main    | stable public release |
| beta    | pre-release preview |
| dev     | integration line (Iris merges features here) |

## Health check

Confirm the local YouEye endpoint is serving from the VM with:
`curl -skL -o /dev/null -w '%{http_code}' https://localhost/`
The command should return `200` or `307` when YouEye is up.
The deploy transcript for the VM lives at `/var/log/youeye-deploy.log`.
