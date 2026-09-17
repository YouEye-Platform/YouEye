# Candidate release transport

The optional release cache supplies exact original URLs from protected local
files while a final-version candidate is tested before publication. It does not
change the selected repository, release tag, signing authority or artifact hash.
Consumers continue normal release signature and provenance verification.

`index.json` uses schema `youeye.release-cache.v1` and maps HTTPS URLs to
`{ "sha256": "...", "bytes": 123 }`. Objects are regular files at
`objects/<sha256>`. A missing index or unmapped URL uses normal network transport;
an invalid present object fails closed. The default root is
`/var/lib/youeye-state/release-cache`; `YOUEYE_RELEASE_CACHE` selects an explicit
host staging directory. No provider credentials belong in the cache.

The Proxmox helper can include `guest-index.json` and its corresponding objects
in answer media. Schema v4 binds that index digest. The installed state holds
the cache separately from sealed system/package content. The Server receives a
copy for initial interface and catalog deployment. Staged testing does not prove
public download availability: publication must reconcile real remote hashes.

On answer ISO media, each digest is split into four 16-character path segments
under `objects/`. This preserves all 64 characters within ISO9660 filename
limits. The installer verifies every indexed media object before changing disks,
then restores `objects/<sha256>` in persistent state after checking its hash.
A valid empty object map explicitly falls back to normal network transport.
The candidate capability advertises `answer_cache_layout: sha256-split-v1` so
release preparation can reject sources using the earlier incompatible layout.
