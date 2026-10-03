# Owner-selected update publishers

Official verification remains enabled. Owners can enroll a personal publisher
for an exact HTTPS repository, branch and scope. A valid personal signature does
not imply official origin. Source selection and trust enrollment are separate;
adding a Market repository grants no authority over the host.

## Persistent signing identity

Use `python3 tools/publisher.py --state-dir <private-directory> init` once.
The command creates an Ed25519 key with private permissions and returns only its
public key and fingerprint. Keep and back up that directory across builds.
Subsequent calls reuse the identity. A missing or changed established key fails
instead of silently changing release authority. Never commit the private directory
or copy it into release artifacts or an AI worker's prompt.

Build unsigned outputs without the private directory mounted. Then run the signer
in a separate trusted process:

```sh
python3 tools/publisher.py --state-dir "$publisher_dir" sign-component \
  --directory "$unsigned_output" --artifact standalone.tar
```

The output must already contain the component artifact, `provenance.json` and
`sbom.spdx.json`. Signing adds `release-development.pub`, `SHA256SUMS` and its
Ed25519 signature. Publish all six files to a new immutable release. Spine
component packages can specify `--artifact spine-linux-amd64` as appropriate to
the existing release contract. The signer refuses existing signing outputs.

For system updates, build using the chosen public identity, the existing unsigned
appliance builder and an explicit release lock for the custom source. Then use
`sign-system-update --directory <output>` to verify the four manifest-selected
payloads and sign `system-update-manifest.json`. Its trust key ID must be the first
16 hexadecimal characters of the identity fingerprint and its class must be
`development`. Publish the manifest, detached signature and exact payloads under
an `appliance-dev-v...` release. This command signs an update bundle; it does not
finalize or certify a bootable installation ISO. Product validation, provenance,
version ordering, compatibility and reproducibility remain the builder's job.

## Host enrollment

After independently choosing the public identity, run as the host owner:

```sh
youeye update-trust enroll --repository https://forge.example/alice/YouEye \
  --branch dev --scope appliance --publisher 'My YouEye' --public-key personal.pub
youeye update-trust show
```

Each host invocation grants only one scope: `appliance`, `spine` or `cp`. UI/app grants
must be enrolled in the Control Panel's separate policy, not merely on the host.
Custom System images currently use the Development manifest/channel contract.
The selected system manifest URL must match its enrolled source and branch.
The normal `youeye update system` selection/staging/activation workflow continues
to enforce signature, manifest, hash, ordering and compatibility checks.

`youeye update-trust revoke --repository <repo> --branch dev --scope appliance`
blocks that source scope without falling back to another key. Explicit enrollment
can replace/re-enable a key when the owner deliberately chooses a new authority.
No legacy-installation migration is included in this first baseline.

Host trust lives at `/var/lib/youeye-state/update-trust.json`, outside the immutable System
image. It must remain in preserved State across updates and recovery. Changing
System slots must not restore revoked grants from an older image. Do not delete
or replace this file when deploying a component. Public keys are not secrets;
write access changes authority and must remain restricted.

## Control Panel and native apps

The administrator-only `/api/settings/update-trust` GET/PUT endpoint manages the
Control Panel's separate policy at `/var/lib/youeye/update-trust.json`. PUT accepts a complete document:

```json
{
  "schema": "youeye.owner-update-trust.v1",
  "grants": [{
    "publisher": "My app",
    "repository": "https://forge.example/alice/App",
    "branch": "main",
    "scope": "app",
    "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
    "revoked": false
  }]
}
```

The endpoint permits only `app` and `ui` scopes. It cannot enroll host authority.
Repository/channel/scope combinations must be unique. App updates from an enrolled
source require a complete valid signature bundle; missing, wrong and revoked
signatures fail closed. Non-enrolled unsigned custom apps remain supported.
Personal signed app records use `verified-custom`, with the enrolled key's SHA-256
SPKI fingerprint, rather than an official label. Source URLs never enroll the
public key that happens to be downloaded beside a package.

This is the CLI/API and signing-tool foundation, not an AI editing interface or a
fork-merging service. Updates continue to follow the explicitly selected source.
A custom system source cannot change implicitly. Returning to another source
requires the owner CLI `--switch-source` option on `youeye update system check`
and `stage`, as well as an exact selected target and normal signature verification.
Returning to official software also requires deliberate source selection and data/schema
compatibility review; signing cannot undo arbitrary custom-code data migrations.
