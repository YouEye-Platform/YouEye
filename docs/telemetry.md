# Local usage statistics

The Control Panel and the dashboard UI can count which pages and features are used. The counts stay on the box:
the trackers only write a local JSON file, and nothing sends them anywhere. Both are **off by default**.

## Control Panel

- Code: `control-panel/src/lib/telemetry/` (`counter.ts` counts routes in the middleware, `tracker.ts` saves them).
- Off until an admin turns on **Local usage statistics** on the Privacy settings page
  (`components/settings-shell/privacy-client.tsx`). The saved file keeps it on only with an explicit opt-in time
  (`explicit_opt_in_at`).
- Saved every 60 s to `/opt/youeye-control-data/telemetry.json` inside `youeye-control` (`TELEMETRY_DATA_DIR`
  overrides the directory).
- Routes, admin only: `GET /settings/api/telemetry/export` downloads the report; `DELETE` resets it (needs the CSRF
  token). `GET`/`PATCH /settings/api/telemetry/settings` reads or sets the switch.

Route paths are normalized: UUIDs and numbers become `[id]`.

## Dashboard UI

- Code: `ui/src/lib/telemetry/tracker.ts`, `ui/src/components/telemetry/telemetry-provider.tsx`.
- On only when the UI process has `TELEMETRY_ENABLED=true` and not `TELEMETRY_DISABLED=true`. The platform does not
  set either variable, so it is off on a normal box.
- When on: the browser batches page views and feature events every 30 s; the server saves counts every 60 s to
  `/opt/youeye-ui-data/telemetry.json` inside `youeye-ui`.
- `GET /api/v1/telemetry/export` (admin) returns the report; `DELETE` resets it.

## What is counted

Route hit counts, feature event counts, app launches (UI) and error summaries (route, message, count). No user
names, IP addresses or request bodies are stored.
