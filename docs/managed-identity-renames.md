# Managed identity during server renames

YouEye coordinates Pointer's persistent trust identity when the server domain
or identity subdomain changes. Ordinary app URL, OAuth and login configuration
updates continue through the application reconfiguration routines.

Before changing site settings or routes, YouEye checks the installed Pointer
release's local identity-transition command against the exact old and new
issuers. An older Pointer without that command, a disabled integration, or an
unexpected stored identity stops the rename before those changes. Update the
YouEye AI service before retrying. No automatic trust override is used.

During the identity stage, YouEye changes routing/settings, invokes Pointer's
database-owner transition, writes its managed environment and verifies readiness.
The transition retains the existing service owner, application registrations,
provider credentials and keys. If that stage fails, YouEye restores the previous
settings/routes and reverses a committed trust transition before restarting the
old configuration. A lost command response is reconciled through Pointer's
durable receipt. Failed recovery is reported explicitly. Concurrent reconfigure
requests in the Control Panel process are rejected.

This recovery boundary covers the Pointer identity stage. Later DNS, certificate
issuance and application updates retain their existing failure behavior; this
is not an atomic rollback of the entire server rename. A process or host failure
can still require operator recovery. Never repair such a failure by deleting
Pointer's database or disabling its persisted-identity checks.
