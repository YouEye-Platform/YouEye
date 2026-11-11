# Private Forgejo releases

A private Forgejo repository can publish the same System releases as GitHub:
a `youeye-v<version>` release whose `core-release.json` lists every artifact by
exact URL, SHA-256 and size (see [core release identity](core-release-contract.md)).
The document's `source` is the Forgejo repository, so its blob URLs sit under
`<source>/releases/download/<tag>/`; the artifact bytes are identical to the
GitHub release.

Forgejo is only ever selected explicitly, for example
`install.sh --repository https://<host>/<owner>/YouEye --channel dev`. Private
`main` releases use the `alpha` channel token; `dev` releases use `-dev.N`.
Publishing a release does not install it. Existing installations update through
the normal update command, which checks the selected source, raw branch and
sequence. Published releases are immutable.
