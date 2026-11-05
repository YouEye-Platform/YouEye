# Release Channels

Spine resolves updates from the release branch it was installed with (`--branch`/`--release-channel`). `youeye update self` and `youeye update control` fetch the latest tag for that branch, falling back to the `main` tag when no branch-specific tag exists.

Signed feature-channel assets may use Forgejo tags whose branch portion contains
safe `/` separators. Forgejo exposes those separators as `%2F` in asset download
URLs. Signature verification preserves that escaped tag segment while replacing
only the final asset name for `release-development.pub`, `SHA256SUMS` and
`SHA256SUMS.sig`; it never reconstructs those sibling URLs from a decoded path.

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
