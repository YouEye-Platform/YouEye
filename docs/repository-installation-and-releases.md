# Installing from repository releases

The bootstrap installs existing release artifacts from the selected repository.
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
Channels select published releases, never a raw branch checkout. `stable` is
the newest non-prerelease `youeye-vX.Y.Z` release and `dev` the newest
prerelease whose tag contains `-dev.`. An alternative source is still distinct
from official Stable.

Releases are unsigned for now. Each System release carries `core-release.json`,
fetched over HTTPS, which lists every artifact by exact URL, SHA-256 and size.
The installer records that document's exact digest in protected State; every
artifact installed or updated later is checked against the accepted document,
and any mismatch fails closed.

Exact tags, artifact hashes and the accepted `core-release.json` identify the
installed bytes and support deterministic recovery. For tracked installations,
first deployment temporarily marks CP/UI pins with `pin_origin: installation`.
Successful finalization removes only those installation-owned pins, preserving
the source, branch and fallback. Explicit owner pins, exact installation and
sealed-service selection remain pinned. Provider flags are no longer supported.
