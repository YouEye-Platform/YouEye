# Installing from repository releases

The bootstrap installs existing signed artifacts from the selected repository.
It follows releases without building source or creating a release per installation.
Official releases are the default. To select another repository:

```sh
curl -fsSL https://releases.youeye.me/install.sh | sh -s -- \
  --repository https://code.example.test/owner/YouEye --channel stable
```

Use the same repository URL in Settings → Software → System update. The installer
and updater derive supported release APIs internally. Repository URLs must use
HTTPS and identify an owner and repository, without credentials, query or fragment.
GitHub and compatible repository release APIs are supported; an unsupported API
fails explicitly. No private server address is embedded in the installer.
Channels select published signed releases, never a raw branch checkout. The
`stable` track means main releases at the selected source; an alternative source
is still distinct from official Stable and keeps its own signing identity.

Existing trusted signing authorities verify releases immediately. An unfamiliar
key is never downloaded and trusted automatically: the owner must explicitly
enroll that authority for the repository, channel and component through the
native trust workflow. The bootstrap uses its compiled authorities and rejects
unfamiliar signing keys. Revoked enrolled trust fails without falling back to
another key. Source selection alone grants no new trust.

Exact tags, artifact hashes and the signed installation snapshot identify the
installed bytes and support deterministic recovery. For tracked installations,
first deployment temporarily marks CP/UI pins with `pin_origin: installation`.
Successful finalization removes only those installation-owned pins, preserving
the source, branch and fallback. Explicit owner pins, exact installation and
sealed-service selection remain pinned. Provider flags are no longer supported.

## Independently released services

An image advertising `private_selection: signed-repository-installation-release`
in `.youeye/release/independent-services.json` can consume a signed metadata-only
`installation-<exact-commit>` release from the selected repository's main channel.
Its `installation.json` binds CP/UI tags, original source commits and artifact
hashes to the exact appliance manifest and baked Spine. Native candidate
installation must pass before the compatible selection is published. Component
signatures are still checked during installation. Missing selection, wrong
source/key and incompatible images fail explicitly.

First deployment persists the authenticated selection and exact external
`appliance-manifest.json` bytes for retries, keeping the same combination
throughout installation. That bundle manifest
has a different representation and digest from the runtime marker inside System.
Deployment verifies the bundle digest authenticated by the signed selection and
binds its image, build, compatibility and sealed release set to the running image.
After first-boot image convergence, it fetches the new image's exact bundle when
the original installer bundle is older; retries use the verified saved bytes.
Immutable selections can be retained
beyond their publication date; live public catalog freshness remains separately
verified. Introducing this consumer requires an initial appliance release.
Subsequent CP/UI-only changes can reuse that image after native compatibility
acceptance. Spine, host, boot, Recovery and embedded Installer changes require
image validation. Each reused component retains its original immutable artifact,
signature, version and source commit, even when that commit differs from the image.
