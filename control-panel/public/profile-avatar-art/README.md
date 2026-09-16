# Profile avatar artwork

These 96 transparent PNGs make the profile presets self-contained. The picker
and stored avatar output therefore do not depend on an operating system emoji
font being installed.

The artwork is attributed to Noto Color Emoji 2.051, copyright Google Inc. and
contributors. Each preset is mapped to a retained SVG from immutable upstream
commit `8998f5dd683424a73e2314a8c1f1e359c19e8742`. Every source SVG and distributed
PNG has a byte size, SHA-256 identity, and Git blob OID in
`legal/noto-avatar-inventory.json`. These content addresses do not prove
upstream authorship on their own. A maintainer with a local clone containing the
fixed commit can bind every retained source to the upstream tree without network
access:

```sh
NOTO_UPSTREAM_REPO=/absolute/path/to/noto-emoji \
  node legal/third-party-assets.test.mjs --verify-noto-upstream
```

The strict command rejects remote URLs, never fetches, and fails if the commit,
tree, or any source blob is unavailable or different. Ordinary validation stays
offline and verifies the retained bytes against both their SHA-256 values and
Git blob OIDs. The historical rendering command and renderer version could not
be recovered, so the inventory does not claim the PNGs can be reproduced from
those SVGs. Noto Color Emoji is licensed under the SIL Open Font License 1.1;
see <https://github.com/googlefonts/noto-emoji>.

The gradient backgrounds, preset names and category assignments are YouEye
product data in `src/lib/profile-avatar-presets.json`.
