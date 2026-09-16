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
3. “Get a secure address” opens the service enrollment page in an explicit
   popup. The exact-origin v1 handoff returns one short-lived proof bound to the
   installation fingerprint. Control Panel consumes it during registration,
   then loads three non-committing previews.
4. Immediately before provisioning, a second popup proof is bound to the exact
   installation fingerprint, selected name, and Spine-reported private/VPN IP.
   It is consumed only by the lease claim.
5. Control Panel stores a protected schema-v2 provisioning record before the
   certificate request. The TLS key and CSR remain local in mode-`0600` state;
   the broker receives only the CSR. Retry or restart reuses the same key/CSR
   and the broker's idempotent job rather than starting a second order.
6. Certificate retrieval waits up to ten minutes to cover the service's DNS
   propagation envelope. Root/wildcard SANs, local key, broker fingerprint,
   provider metadata, and dates are validated before Caddy activation and
   atomic certificate persistence.
7. A first heartbeat is attempted immediately. Six-hour maintenance continues
   heartbeat, IP-only DNS updates, renewal, and provisioning recovery.

The browser popup never receives the installation private key, TLS private
key, or server IP. The popup returns no Turnstile response, context, cdata, or
provider secret. Proofs remain in browser memory only, are exact-purpose and
exact-binding checked, and are acknowledged only after local acceptance.

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

- Lifecycle schema v2 stores the immutable service ID/origin/API/zone binding,
  actual FQDN, provisioning stage, consent, certificate state, contact times,
  and redacted error/request ID.
- Recovery bundle schema v3 stores the same service binding plus the protected
  installation identity, TLS key/certificate, certificate metadata, and
  consent. It is a credential and retains the existing regular-file,
  no-symlink, size, ownership, mode-`0600`, no-overwrite, and explicit-stdout
  safeguards.
- This pre-release cutover intentionally has no `.youeye.me`, lifecycle-v1, or
  bundle-v2 compatibility path. Obsolete state fails closed rather than being
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
