# Private Forgejo main releases

The release controller may promote accepted development source to a private
Forgejo main release. Component and appliance tags use five-position numeric
versions. Canvas source templates and Market snapshots follow their own release
contracts.

The Installer verifies a five-position `appliance-v` release with the existing
private development trust anchor only when discovery explicitly selected a
Forgejo provider. Its signed appliance manifest must identify the same selected
repository and the main branch. Provider-returned JSON cannot set that trust
context. Public GitHub Stable retains a separate trust boundary.

A release promotion publishes artifacts; it does not install them. Existing
installations still use the supported update command and exact-source checks.
Versions embedded in components, the appliance release lock, checksums and
signatures must agree. Published releases are immutable.

Appliance release locks use unqualified component tags on main (`spine-v…`,
`cp-v…`, `ui-v…`). Dev and feature branches retain the branch in each tag.
The appliance build entry uses the shared release-lock validator for this check.
