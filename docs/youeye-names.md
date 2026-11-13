# YouEye Names

YouEye Names gives a box on a home network a real HTTPS name, such as `sandy-spring.ui.bingo`, without an account.
The box holds the name with a key; the Names service (the "broker") points the DNS record at the box's private IP
and gets it a public certificate.

- The broker is the separate `YouEye-Names` repo, running on Cloudflare at `https://names.youeye.me`. It is the
  only Names service the product talks to.
- The box side is in the Control Panel: `control-panel/src/lib/youeye-names/`, the setup wizard
  (`components/setup/SetupServerName.tsx`, `app/api/setup/run/route.ts`) and `app/api/tls/youeye-names/*`.
- The service origin and the DNS zone are separate. The zone comes from the service (today `ui.bingo`); never derive
  one from the other.

## Service discovery

`lib/youeye-names/service.ts` reads `GET /v1/service-info` (8 s timeout, at most 64 KiB) and requires:

- `apiVersion: v1`;
- a canonical origin equal to the origin it contacted;
- service ID `youeye-names-official`;
- the capabilities `install-signatures`, `lease-lifecycle` and `certificate-lifecycle`;
- a valid managed zone.

`YOUEYE_NAMES_URL` and `YOUEYE_NAMES_EXPECTED_SERVICE_ID` override the origin and ID for development; the defaults
are the official ones. `GET /v1/readiness` tells setup whether a new name can be made now.

## The box's identity

- The box's Names identity is an Ed25519 key pair (`identity.ts`). The private key is the authority for the name.
- Every authenticated request is signed over seven lines: method, path, timestamp, nonce, SHA-256 of the body,
  service ID, service origin (`client.ts`). The request also carries `x-youeye-install-fingerprint`,
  `x-youeye-timestamp`, `x-youeye-nonce`, `x-youeye-signature`, `x-youeye-service-id` and
  `x-youeye-service-origin`. Binding the service ID and origin stops a signature being replayed to another
  service.

## Setup flow

1. Setup loads readiness. `degraded` with `canProceedNow=true` shows an amber warning. Paused, blocked, malformed or
   unreachable blocks only a new Names setup; the own-domain (ACME), self-signed and upload choices stay available.
2. **Preview.** "Get a secure address" shows generated name choices (`/v1/leases/preview`). A preview creates
   nothing: no registration, lease, DNS record or certificate.
3. **Human check.** With the `verified-setup-v1` capability, the box asks the broker for one verification for the
   chosen name (`/v1/human-verification/challenges`). The broker's page opens in an iframe
   (`/enroll/embedded`). Its signed context binds the broker, the box's fingerprint, the chosen name, the box's
   private IP (from Spine), the browser's parent origin and a random session ID, and expires within 5 minutes. The
   parent origin is checked against the request's actual `Host` (`setup-request.ts`). The result is kept only in
   memory. If the iframe cannot load, a standalone page (`/enroll/setup`) is offered, and its short code can be
   pasted back.
   - If the service does not advertise `verified-setup-v1`, setup uses a popup instead (`popup.ts`): one check to
     register the box, then a separate proof for the claim.
4. **Register and claim.** The CP registers the box with the verified session (`/v1/installs/register`) and claims
   the exact name and IP with the same session (`/v1/leases/claim`). The human check is never reused for a second
   name.
5. **Certificate.** The CP writes the lifecycle record, makes a TLS key and CSR locally (mode `0600`), requests the
   certificate and waits up to 10 minutes for it. A retry or restart reuses the same key, CSR and request.
6. **Activate.** The certificate's names, key, broker fingerprint, provider and dates are checked before Caddy loads
   it. A first heartbeat is sent at once.
7. **Check from the browser.** The setup-complete page opens the new name from the owner's browser to prove that
   their DNS resolver and HTTPS reach it. The service being healthy cannot prove that.

No private install key, TLS key or human-check token ever reaches browser code.

## Maintenance

`maintenance.ts` runs in the Control Panel 90–150 seconds after start, then every 6 hours:

- resume an interrupted setup from its recorded stage;
- check that the certificate Caddy serves matches `lifecycle.json`;
- heartbeat (`/v1/leases/<name>/heartbeat`) with the box's primary IP, certificate fingerprint and expiry, version
  and Caddy health;
- renew the certificate when it expires within 30 days or the broker asks for a new CSR, then swap it in Caddy.
  Renewal needs the current certificate terms version to have been accepted.

When the host's IP changes, Spine calls the Control Panel's `POST /api/host-ip/migrate`, which updates the name's
DNS record (`/v1/leases/<name>/ip`).

Settings → Network shows dot-plus-word status for reachability, whether new names can be made, and coarse DNS and
the state of the primary and fallback CA (Google Public CA and Let's Encrypt). It never shows quotas, raw provider errors or
credentials. Heartbeat, renewal, export, revoke and release report their own results.

## Saved state

The files live inside the `youeye-control` container under `/opt/youeye-control-data/youeye-names/`
(`YOUEYE_NAMES_DATA_DIR` overrides it).

| File | Contents |
|---|---|
| `install-identity.json` | the Ed25519 identity |
| `lifecycle.json` | `schemaVersion: 1`: service ID, origin, API and zone; name and FQDN; status (`provisioning`, `healthy`, `renewing`, `attention`, `released`); setup stage (`lease_claimed` … `activating`) with the pending key and CSR; consent; certificate metadata; last contact, heartbeat and next check |

All Names files must be regular files with mode `0600`; anything else is refused. Records in any other format are
refused, never reinterpreted.

## Saved Names (recovery bundle)

The recovery bundle lets a reinstalled box keep its name and certificate without a new issuance.

- Contents (`bundle.ts`, `schemaVersion: 1`): service binding, name and FQDN, the install identity, the TLS key and
  certificate, certificate metadata (fingerprint, provider, dates) and consent (terms version, certificate
  transparency acceptance).
- It contains private keys: treat it as a credential.
- Export: `youeye names export --output <new-file>` (writes mode `0600`, never overwrites; `--stdout` must be asked
  for explicitly), or `GET /api/tls/youeye-names/export` (admin).
- Import: `youeye names import <bundle.json>`.
  - Before setup, Spine stages it at `/opt/youeye-control-data/youeye-names/import-bundle.json`. Setup sees it
    (`GET /api/tls/youeye-names/reuse`), locks the address to that name and validates the bundle again before use.
  - After setup, it calls `POST /api/tls/youeye-names/apply`, which installs the identity and runs the full server
    URL change to the saved name. Settings → Network → Domain offers the same.
- Requesting a new setup verification is not a way to recover a name you own; use the bundle.

## Failure modes

| Symptom | Cause and fix |
|---|---|
| Names option blocked in setup | Service unreachable, paused or blocked (readiness). Pick another TLS option or retry later. |
| `youeye_names_service_*` errors | Discovery failed: wrong origin, service ID, missing capability or bad zone. Check `YOUEYE_NAMES_URL` is unset on a normal box. |
| "certificate is taking longer than usual" | Issuance took over 10 minutes. Retry the step; it reuses the same key and request. |
| Name works on the box but not in the browser | The owner's DNS resolver or network cannot reach the private IP. The setup-complete check shows this. |
| Lost name after reinstall | Restore the exported bundle with `youeye names import`. Without it, the name cannot be recovered. |
| `lifecycle.json` invalid | The file was edited, has the wrong mode or an old format. It is refused on purpose; restore it from a backup or the bundle. |
| IP changed but DNS did not follow | The host IP migration (`/api/host-ip/migrate`) updates DNS; check its result in the Control Panel log. |
