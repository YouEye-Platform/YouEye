# Market and native app sign-in tests (YouEye ID)

Browser tests that sign in to installed apps with YouEye ID, once as a YouEye **admin** and once as a
**standard user**, then ask the app who is signed in and whether that person is an admin there.
Expected: admin → admin in the app; standard user → signed in, not admin. Apps with a known gap record
it in `apps.config.mjs` as `expect`, so a fix shows up as a failing test.

No passwords are used anywhere. Every browser starts from a saved YouEye ID session.

## Files

| File | What |
|---|---|
| `apps.config.mjs` | One entry per app: subdomain, how a person starts sign-in, `whoami()` |
| `lib.mjs` | `signIn()` (start flow, accept consent, wait until back on the app), `pageFetch()`, `box()`/`psql()` |
| `apps.spec.ts`, `playwright.config.ts` | The suite: per app, `admin` and `user` tests. Apps that are not installed are skipped |
| `probe.mjs` | Same flow for one app, printed (for exploring a new app): `node probe.mjs <app> [admin\|user]` |
| `explore.mjs` | Open a URL with a session, list buttons/links, screenshot |
| `save-session.mjs` | Opens a browser window; a person signs in to YouEye ID; the session goes to `.auth/<name>.json` |
| `warm-sessions.mjs` | Re-establishes the Control Panel sessions from the saved YouEye ID sessions |
| `set-access.mjs` | `node set-access.mjs <app> all_users`: admit standard users (new apps are owner-only) |
| `app-round.sh` | Install / restart / remove harness for one app on the test box |
| `install-api.mjs` | Install an app through the Control Panel API as the admin, AI Settings off |
| `sign-in.mjs` | `node sign-in.mjs <app> off\|on`: turn an app's YouEye ID sign-in off/on (re-runs its `setup/sso.yaml`) |
| `connect-suggestions.mjs` | `node connect-suggestions.mjs [from>to …]`: list connection suggestions; approve the named ones (like Connect on a suggestion card) |
| `vaultwarden-probe.mjs` | Vaultwarden's flow up to the master-password step (types the account email only) |

## Prerequisites

- Node 24 (`~/.cache/youeye-build/node-24.22.0/bin` first on `PATH`), then `npm ci` and
  `npx playwright install chromium` once.
- A test box. Set `BOX_DOMAIN` to its domain (e.g. `export BOX_DOMAIN=<name>.ui.bingo`).
- Two YouEye ID users: an admin (default username `tester`, override `ADMIN_USERNAME`) and a standard user
  (`tester2`, override `USER_USERNAME`).
- Saved sessions (git-ignored, `.auth/`). A person makes them once per box:

  ```sh
  node save-session.mjs admin https://$BOX_DOMAIN   # sign in as the admin, close the window
  node save-session.mjs user  https://$BOX_DOMAIN   # sign in as the standard user
  node warm-sessions.mjs                                    # optional: Control Panel sessions too
  ```

- Optional `BOX_SSH` for apps whose check runs on the box (FreshRSS): the ssh command without the remote command,
  e.g. `BOX_SSH="ssh -i ~/.ssh/<key> -o BatchMode=yes root@<box-ip>"`. Without it those checks are skipped.

## Run

Install the app(s) first (one at a time on an 8 GB box), and admit standard users:

```sh
ssh root@<box> youeye app install jellyfin
node set-access.mjs jellyfin all_users
npx playwright test                         # every installed app in apps.config.mjs
APPS=jellyfin,nextcloud npx playwright test # only these
```

Screenshots land in `test-results/<app>-<who>.png`; the HTML report in `playwright-report/`. The hops and the
`whoami` result are attached to each test as annotations.

Notes:
- Run `admin` before `user` on a fresh install: Actual Budget and Linkwarden make the first person who signs in the
  instance admin (no upstream claim mapping; their listings tell the owner to sign in first). Open WebUI also makes
  its very first account admin, but corrects roles from YouEye ID at the next sign-in.
- Apps with a known gap record it as `expect` in `apps.config.mjs` (Kavita, Memos, Miniflux, Vikunja: YouEye ID
  admins are not app admins; HedgeDoc has no admin role). Results: `Notes/sessions/2026-11-13-sso-results.md`.
- Some checks run on the box (FreshRSS, HedgeDoc): set `BOX_SSH`.
- Actual Budget answers 429 when two OpenID sign-ins come within about a minute; rerun after a minute.
- Not in the table: Vaultwarden (ends at the master-password form; use `vaultwarden-probe.mjs`).
