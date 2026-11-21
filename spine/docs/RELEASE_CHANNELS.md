# Release Channels

A box follows one channel: `dev`, `alpha`, `beta` or `stable`. The installer records it, with the release repository,
in protected State; `youeye channel get` prints it and `youeye channel set <channel>` changes it (so does Settings in
the Control Panel, through Spine). A box never downgrades: on a channel whose release is older than the installed
one it waits for the channel to catch up.

There is one update, the System update. Spine reads the channel's index (`index.json`), which names one release
document, `core-release.json`, and that document binds the image, Spine, the Control Panel and the UI by sha256 and
size. `youeye update core check` shows what the channel offers; `youeye update core stage` and `activate` (or Settings
→ System) install it. There is no `youeye update self` or `youeye update control`: no part is updated by itself.

Releases are unsigned for now. Every downloaded artifact is checked by sha256
and size against the accepted `core-release.json` (fetched over HTTPS; its exact
digest is recorded in protected State by the installer), or against the
channel's pinned digest. A missing digest or a mismatch fails closed.

| Channel | Meaning |
|---------|---------|
| dev     | every build (`X.Y.Z-dev.N`) |
| alpha   | a build promoted from dev |
| beta    | pre-release preview |
| stable  | public release |

Promotion never rebuilds: the same files get a new release document on the next channel. The whole picture is in
[`docs/releases.md`](../../docs/releases.md) and [`docs/core-release-contract.md`](../../docs/core-release-contract.md).

## Health check

Confirm the local YouEye endpoint is serving from the VM with:
`curl -skL -o /dev/null -w '%{http_code}' https://localhost/`
The command should return `200` or `307` when YouEye is up.
The deploy transcript for the VM lives at `/var/log/youeye-deploy.log`.
