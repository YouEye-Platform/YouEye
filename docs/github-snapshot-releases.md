# Public snapshot release contract

A GitHub release projects reviewed source into one new public commit, preserving
previous public release history without importing private development ancestry.
GitHub beta uses four numeric version positions and beta-prefixed component tags;
GitHub main uses three positions and main component tags. Direct alpha-to-main
release preparation is supported by the publishing coordinator.

Public appliance source declares `.youeye/release/github.json` and contains
`appliance/release-recipe.json` with schema `youeye.appliance.recipe.v1`, an
`image` object matching release-lock image fields, and `market_branch`. The exact
build receives a detached `youeye.appliance.release-lock.v1` lock. Image metadata
must equal the committed recipe; all core component pins name the final source
commit. Artifact hashes belong in this detached lock, never in a self-referential
source commit. Signed provenance binds its exact digest.

`APPLIANCE_TRUST_CLASS` is development, beta or stable. Public beta must use beta;
public stable must use main. The reviewed public projection installs Ed25519
public anchors in Installer and updater `public-release-trust.json` files and
selects `appliance-public.pub`. Default development source contains no public
release keys and cannot authorize beta/stable signatures. Public releases use the
compiled channel anchor, never a caller-supplied or downloaded replacement key.
The legacy bundle asset name `appliance-development.pub` remains for compatibility;
its key bytes and signed trust class identify the actual selected public signer.

Creating a source contract does not publish a release, provision signing keys,
promote development source, or install/update a machine. Full signed build and
native install/update acceptance must be recorded separately by the release owner.
