# Appliance build inputs

The appliance builder is source-owned and runs through the versioned build
manifest. Source identity, the exact release lock, package snapshot and executor
build kit are inputs to independent reproducibility verification.

System and recovery images use Zstandard 1.5.7, level 10, one worker and a 27-bit
long window. The source pins these parameters and rejects a different compressor
version. Policy changes change the signed source identity and require independent
A/B output verification. One worker avoids oversubscribing concurrent jobs.

Level 10 trades moderately larger downloads for shorter compression time.
Decompressed image contents are unchanged. Reverting to the previous level 19
policy requires a source change and a new verified release, not a runtime flag.

## Composed development test images

Sources advertising `.youeye/release/composition.json` support an explicit
`youeye.appliance.release-lock.v2` test lock. Each Spine, Control Panel and UI
entry records its original release branch, tag, version, source commit and
artifact digest. The resulting `youeye.release-set.v2` is development-only;
existing single-branch release sets retain their original contract.

The appliance recipe/ISO installer source and component releases are independent
inputs. The build coordinator verifies the published component signatures and
provides the original released Spine executable through
`YOUEYE_COMPOSITION_SPINE_FILE`. The recipe checks its pinned digest before
embedding it. Control Panel and UI download their original signed releases.
An older Spine without the composition capability cannot interpret this contract
and must be rejected before building.

A composed image has its own test branch, image version and build identity bound
to the complete lock digest. It is never presented as the unmodified base
release. The host helper and ISO installer both come from the selected appliance
builder source; component overrides do not implicitly change that source.
Composition tests demonstrate compatibility of the selected set, not acceptance
of an untouched public release. Public trust contexts reject this test format.
