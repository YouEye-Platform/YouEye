# App-network acceptance fixtures

These test-only manifests exercise supported `youeye app install --url` and
authenticated Market acceptance. They must not be published to the production
Market catalog.

The fixtures intentionally use a versioned upstream Nginx image. Acceptance
records both each YAML digest and the resolved live Incus image fingerprint.

- `healthy-single.yaml` — one-container healthy install.
- `healthy-multi.yaml` — two containers on one primary app bridge.
- `integration-source.yaml` / `integration-target.yaml` — explicit connection
  grant and revocation.
- `fail-image.yaml` — deterministic image resolution failure after reservation.
- `fail-health.yaml` — deterministic health failure after bridge and container
  creation.
