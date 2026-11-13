# YouEye Names product integration

The Development product uses the official accountless YouEye Names service at
`https://names.youeye.me`. The service advertises the managed zone; the current
production contract is `ui.bingo`. The API origin and DNS zone are independent
and must never be derived from each other.

## Fresh setup

1. Control Panel fetches `/v1/service-info`, requires API `v1`, the exact
   canonical origin, service ID `youeye-names-official`, a valid managed zone,
   and the required install/lease/certificate capabilities.
2. `/v1/readiness` appears before mutation. `degraded` with
   `canProceedNow=true` is an amber warning; paused, blocked, malformed, or
   unreachable service state blocks only a new Names setup and leaves the BYO,
   self-signed, and uploaded-certificate choices available.
3. With the `verified-setup-v1` capability, “Get a secure address” loads
   non-committing generated choices using anonymous, signed setup contexts.
   No install registration, human decision, lease, DNS or certificate is created
   by preview. The final human challenge is requested only for the selected name.
4. Immediately before provisioning, a dedicated Names iframe verifies one
   bounded setup session. Its signed context binds the broker identity/origin,
   install fingerprint, exact chosen name, Spine-reported private/VPN IP, exact
   browser parent origin and random attempt channel. Registration and claim
   share this one decision; the Turnstile response is never reused for a second
   domain action. The session expires after at most five minutes and is kept
   only in browser/request memory.
5. Control Panel registers using `verifiedSetupSession`, even when the key is
   already registered or cached, then signs the exact name/IP claim using that
   same session. It stores a protected provisioning record (`lifecycle.json`) before the
   certificate request. The TLS key and CSR remain local in mode-`0600` state;
   retry or restart reuses the same key/CSR and idempotent certificate job.
6. Certificate retrieval waits up to ten minutes to cover the service's DNS
   propagation envelope. Root/wildcard SANs, local key, broker fingerprint,
   provider metadata and dates are validated before Caddy activation.
7. A first heartbeat is attempted immediately. Six-hour maintenance continues
   heartbeat, IP-only DNS updates, renewal and provisioning recovery.

## Verification transport and compatibility

Names must be deployed before clients enable its discovered capability. Services
without it retain the existing registration popup followed by a separate exact
claim proof. Legacy v1 clients remain supported by the upgraded service. Saved
identity/name/certificate bundles retain their existing authenticated reuse path;
requesting a new setup grant is not a substitute for recovering an owned name.

The new iframe uses `/enroll/embedded` and only its signed admitted parent in
CSP `frame-ancestors`. The ordinary `/enroll` remains unframeable. The parent
captures the exact local browser origin, and its API checks that origin against
actual request Host rather than a caller-provided origin or forwarded-host guess.
The iframe is sandboxed and uses no-referrer. The selected broker's HTTPS origin,
exact Window, version, random channel, init/result shape, fingerprint, name, IP
and finite bounded expiry must match. A result is acknowledged only after
retaining it in the current in-memory attempt. Cancel, Back, unmount, superseding
choices and expiry remove listeners and prevent stale results from starting
provisioning. Names API redirects fail closed, and a mismatched registration
fingerprint never becomes cached authority.

HTTP LAN setup uses `crypto.getRandomValues` for standard UUID v4 attempt and
restore/onboarding operation IDs; there is no insecure randomness fallback.
The service's signed frame admission pins the exact context and canonical
public key after server-side authentication/fingerprint checks. The frame
compares exact init values instead of depending on `crypto.subtle`, which is
unavailable below an HTTP ancestor even when the frame itself uses HTTPS.
Admission URLs contain bounded public key/name/LAN-IP metadata, never a provider
response or setup credential; do not log URL queries. If the browser/provider
still prevents embedding, the standalone and manual paths remain available.

If embedded verification cannot load, the visible standalone action opens
`/enroll/setup` using the same signed context/channel. If browser isolation or
popup blocking prevents automatic return, its short-lived code can be pasted
into the current attempt. It must contain that attempt's exact context; the
broker still validates its issued digest, expiry and install signature. No
private install key, TLS key, provider secret or Turnstile response reaches
Control Panel browser code. The new result includes the exact private/VPN IP
binding; it is not written to browser persistent storage or diagnostics.

Neither a successful verification nor an accepted session means the lease,
certificate or browser connection is ready. Real browser/provider acceptance
must cover the iframe, standalone return, manual fallback, legacy flow and saved
bundle reuse separately. Source tests and service health do not prove those
installed journeys. The broker's ephemeral session schema must exist in both
PostgreSQL and D1 and must stay outside portable rollback data snapshots.

## Signed request contract

All install-authenticated requests sign seven newline-separated fields:

```text
method
path
timestamp
nonce
body SHA-256
service ID
canonical service origin
```

They also send `x-youeye-service-id` and `x-youeye-service-origin`. This binds
an otherwise valid installation signature to the discovered broker and blocks
cross-service replay.

## Durable state and recovery

- The lifecycle record (`schemaVersion: 1`) stores the immutable service ID/origin/API/zone binding,
  actual FQDN, provisioning stage, consent, certificate state, contact times,
  and redacted error/request ID.
- The recovery bundle (`schemaVersion: 1`) stores the same service binding plus the protected
  installation identity, TLS key/certificate, certificate metadata, and
  consent. It is a credential and retains the existing regular-file,
  no-symlink, size, ownership, mode-`0600`, no-overwrite, and explicit-stdout
  safeguards.
- There is no `.youeye.me` compatibility path, and lifecycle records or bundles
  in earlier formats are refused. Obsolete state fails closed rather than being
  silently reinterpreted as `ui.bingo` authority.

## Health presentation

Setup and Settings show dot-plus-word status for reachability and whether new
installation may proceed. Settings also shows coarse DNS, Google Public CA
primary, and Let's Encrypt fallback availability. It never displays private
quota, provider errors, credentials, or an issuance promise. Existing
heartbeat, renewal, export, revocation, and release continue to use their own
route results rather than treating new-install admission as a global outage.

The post-setup page separately tests the chosen named origin from the owner's
browser with an exact iframe window/origin handshake. This is the device-side
proof that local DNS and trusted HTTPS can reach the new `ui.bingo` address;
service readiness alone cannot prove the owner's resolver path.
