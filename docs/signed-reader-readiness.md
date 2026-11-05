# Persistent signed reader readiness

System discovery can acquire the exact selected release's original Stable Spine
as a reader before the owner requests an update. Acquisition authenticates and
stores immutable inputs. It creates no update request, transaction journal,
coordinator registration, slot stage, activation or reboot. The installed System
receipt and baked executable remain unchanged.

Automatic acquisition applies only to a selected complete official Stable
release whose original Spine is itself official Stable and differs from the
installed Spine. Custom sources keep their normal selected-source behavior.
There is no automatic fallback to the official publisher. Original readers
without the new signed capabilities retain the existing explicit manual bridge.

The native cache stages only the Spine role through its ordinary signed download
pipeline, after checking all fourteen current role authorities. Current owner
overrides and revocations remain effective. A downloaded public key never grants
authority. Original signed provenance must positively advertise the supported
reader contract:

```text
core-release-v1
core-metadata-pair-v2
core-control-v1
bootstrap-state-v1
```

The exact source owns `.youeye/release/reader-capabilities.json`. The component
signer copies that declaration into original Spine provenance before sealing and
signing. Source without the declaration advertises no new capabilities. The file
is a Spine and appliance build input. The current route intentionally preserves
v1 execution compatibility; it does not claim to bootstrap arbitrary future
manifest or cryptographic formats.

Protected state under `/var/lib/youeye-state/core-update/` contains
`reader-ready.json` and the existing `bootstrap/<original-spine-sha256>/` envelope.
That envelope retains the original binary, checksums, signature, provenance and
SBOM, plus the exact signed execution selection. Paired metadata retains its
authenticated `core-metadata.json` proof sidecar. Original artifact and provenance
bytes are never relabeled or rewritten.

Readiness pins the exact selection, original artifact/version/capabilities,
installed baseline, actual partition/state identity and SMBIOS UUID. A malformed,
missing-payload, stale-selection, wrong-machine or revoked record cannot authorize
Stage. The API reads managed readiness per operation; a completed target or a
different selected custom source does not remain pinned to a former reader.
The browser projection reports readiness/version/digests and a machine-bound
boolean without exposing the protected machine identities or executable path.

```sh
youeye update core reader acquire
youeye update core reader status
```

`status` authenticates readiness against the current selection and machine; it
does not acquire a reader or create update intent. `acquire` is idempotent for
the same valid readiness and resumes verified partial acquisition after an
interruption. A final quiescent check precedes readiness publication. Existing
Core/host requests, production coordinators, native controllers/actions,
app/backup/container work and independent copies prevent retargeting. A separate
protected lease fences the exact verify/prepare/register boundary against a
concurrent acquisition.

Only the ordinary explicit Stage action prepares its exact request and then
registers the existing target-bound bootstrap coordinator and owned volatile boot
continuation. Continued/recovered work uses that production coordinator.
Completed and retained historical deliveries never register a new reader or replay
their effects. Explicit manually selected reader flags retain their strict frozen
manifest contract.

The ready record and original envelope survive API restart and reboot. A partial
acquisition has no ready record and cannot become a native coordinator. The next
acquisition rechecks the original signatures, current source scopes, selected
manifest and machine before accepting it. Corrupt original bytes fail closed.

Reader envelopes remain protected recovery inputs while referenced by current
readiness, a native bootstrap/request or a running executable. Retargeting does
not sweep unrelated or historical bootstrap directories. Retire superseded bytes
only after reconciling their exact native/process references and preserving the
installed/pending reader plus a usable preceding recovery chain. Readiness alone
does not prove that an old retained directory is disposable.
