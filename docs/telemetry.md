# Usage Telemetry (Beta)

YouEye includes a lightweight, anonymous usage tracker to help identify unused features and dead code during the private beta period.

## What's Collected

| Data | Example | Purpose |
|------|---------|---------|
| Page visit counts | `/dashboard`: 47, `/settings/appearance`: 3 | Find pages nobody visits |
| Feature usage | `widget_add`: 5, `theme_change`: 1 | Find features nobody uses |
| App launches | `wiki`: 12, `cinema`: 3 | Find apps nobody opens |
| Error summaries | Route + message + count | Find recurring bugs |

## What's NOT Collected

- No usernames, emails, or personal data
- No IP addresses or device fingerprints
- No request bodies or form data
- No browsing history or timing data
- No screenshots or keystrokes

## How It Works

1. **Client-side**: A `TelemetryProvider` in the UI tracks page views (route changes) and feature interactions. Events are batched and sent to the server every 30 seconds.
2. **Server-side**: The UI stores counters in `/opt/youeye-ui-data/telemetry.json`. The Control Panel stores its route counters in `/opt/youeye-control-data/telemetry.json`.
3. **Export**: Admins can download the usage report from **Settings → About & Usage → Download Report**.

## Downloading the Report

### From the UI (recommended)

1. Go to **Settings** → **About & Usage** (admin section)
2. Click **Download Report**
3. A JSON file downloads with all usage data

### From the CLI

```bash
# UI telemetry
sudo incus exec youeye-ui -- cat /opt/youeye-ui-data/telemetry.json

# Control Panel telemetry
sudo incus exec youeye-control -- cat /opt/youeye-control-data/telemetry.json
```

### Via API

```bash
# Export UI telemetry (requires admin session cookie)
curl -b "ye-ui-session=<token>" https://yourdomain.com/api/v1/telemetry/export

# Reset UI telemetry
curl -X DELETE -b "ye-ui-session=<token>" https://yourdomain.com/api/v1/telemetry/export
```

## Report Format

```json
{
  "version": "1",
  "period_start": "2026-05-16T10:00:00.000Z",
  "last_flush": "2026-05-16T18:30:00.000Z",
  "routes": {
    "/dashboard": 47,
    "/settings": 12,
    "/settings/appearance": 8,
    "/api/v1/widgets": 23
  },
  "features": {
    "widget_add": 5,
    "widget_resize": 3,
    "app_drawer_open": 14,
    "theme_change": 1
  },
  "apps_launched": {
    "wiki": 12,
    "search": 8,
    "cinema": 3
  },
  "errors": [
    {
      "route": "/api/v1/widgets",
      "message": "Invalid widget data",
      "count": 2,
      "last_seen": "2026-05-16T15:30:00.000Z"
    }
  ],
  "platform": {
    "ui_version": "0.4.1",
    "node_version": "v22.0.0",
    "export_date": "2026-05-16T18:30:00.000Z"
  }
}
```

## Sharing Your Report

During the beta, you can help improve YouEye by sharing your usage report:

1. Download the report from Settings → About & Usage
2. Email it to the development team

Routes with **0 hits** indicate potentially dead code. Features with **0 hits** might be undiscoverable or broken.

## Disabling Telemetry

Telemetry is on by default during the beta. To disable it, set the environment variable:

```bash
TELEMETRY_DISABLED=true
```

This stops recording new events. Existing data remains on disk until manually deleted or reset.

## Data Storage

- **UI**: `/opt/youeye-ui-data/telemetry.json` (survives app redeploys)
- **CP**: `/opt/youeye-control-data/telemetry.json` (survives app redeploys)
- Data is flushed to disk every 60 seconds
- No external services, no network transmission — everything stays local

## Temporary Feature

This telemetry system is specifically for the private beta testing period. It will be removed in a future release once we have enough data to identify and clean up dead code paths.
