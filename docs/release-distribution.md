# Release discovery

A System release is one Forgejo or GitHub release tagged `youeye-v<version>`.
Its asset `core-release.json` (`youeye.core-release.v1`, `authority: "digest"`)
lists every System artifact with its exact download URL, SHA-256 and size.
Nothing in the release path is signed. Integrity comes from HTTPS with normal
certificate checks and from SHA-256: the document digest is the root, and every
artifact it names is checked by digest and size before use.

The official source is `https://github.com/YouEye-Platform/YouEye`. Any other
repository is used only when an operator selects it explicitly with
`--repository`. `https://releases.youeye.me/install.sh` hosts the public
bootstrap; there is no separate signed catalog service.

## How releases are found

Clients list releases through the provider API:

- GitHub: `https://api.github.com/repos/<owner>/<repo>/releases?per_page=100&page=N`
- Forgejo: `https://<host>/api/v1/repos/<owner>/<repo>/releases?limit=50&page=N`

Only non-draft `youeye-v` tags count. The bootstrap (`install.sh`) and the Go
Installer apply the same channel rule:

| Channel | Release picked |
|---|---|
| `stable` | newest non-prerelease `youeye-vX.Y.Z*` whose document names branch `main` |
| `dev` | newest prerelease whose tag contains `-dev.` and whose document names branch `dev` |
| `branch` | newest `youeye-v*` release whose document names the requested branch |
| `exact` | the requested tag, optionally pinned by its `core-release.json` SHA-256 |

"Newest" is version order (`0.6.0-dev.10` after `0.6.0-dev.2`, a release after its
prereleases). A channel never falls back to another channel.

Downloads use the asset URLs under `<source>/releases/download/<tag>/`. GitHub
may redirect them to `objects.githubusercontent.com` or
`release-assets.githubusercontent.com`; other hosts may not redirect to a
different origin. A member built in another repository is fetched from the
selected release as `blob-<sha256>` when its original URL is outside the
selected source.

## What the Installer records

The Installer writes the exact `core-release.json` bytes to
`/var/lib/youeye-state/bootstrap/core-release.json` and its SHA-256 to
`core_manifest_sha256` in `/var/lib/youeye-state/bootstrap/release-policy.json`.
The installed image manifest (`/var/lib/youeye-state/installer/appliance-manifest.json`)
equals the `appliance` member artifact. Spine accepts only that recorded
document until an update replaces it.

`release-policy.json` also records the release source (`provider`,
`releases_api`) and the selection (`mode`, `track`, `branch`). System updates
always follow that recorded source and track; the Control Panel, which runs in
an Incus container, can display the selection but cannot change it. When the
public bootstrap starts the Installer it passes the exact tag and
`core-release.json` digest it verified, so the Installer installs that release
while still recording the selected track. Signing returns before the first
public release.

## Troubleshooting

- GitHub API 403 or 429: anonymous API quota is limited per IP address. Wait, or
  use `--channel exact --release-tag <tag>` (still one listing request).
- Checksum mismatch: the download differs from `core-release.json`. Retry; do
  not edit the document or bypass the check.
- TLS failures: check DNS, TLS interception and IPv4/IPv6 connectivity. Never
  disable certificate verification.
