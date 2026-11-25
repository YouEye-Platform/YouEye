# Market and native app sign-in tests (YouEye ID)

Browser tests that sign in to installed apps with YouEye ID, once as a YouEye **admin** and once as a
**standard user**, then ask the app who is signed in and whether that person is an admin there.
Expected: admin → admin in the app; standard user → signed in, not admin. Apps with a known gap record
it in `apps.config.mjs` as `expect`, so a fix shows up as a failing test.

The tests use no passwords: every browser starts from a saved YouEye ID session (`.auth/admin.json`,
`.auth/user.json`). On test boxes `login.mjs` makes those sessions from the standard test accounts, which it gets from
the environment only (no password is kept in this repository).

## Files

| File | What |
|---|---|
| `apps.config.mjs` | One entry per app: subdomain, how a person starts sign-in, `whoami()` |
| `lib.mjs` | `signIn()` (start flow, accept consent, wait until back on the app), `pageFetch()`, `box()`/`psql()` |
| `apps.spec.ts`, `playwright.config.ts` | The suite: per app, `admin` and `user` tests. Apps that are not installed are skipped |
| `probe.mjs` | Same flow for one app, printed (for exploring a new app): `node probe.mjs <app> [admin\|user]` |
| `explore.mjs` | Open a URL with a session, list buttons/links, screenshot |
| `login.mjs` | Test boxes: signs the admin and the standard user in to YouEye ID with the accounts from the environment, saves `.auth/admin.json` and `.auth/user.json`, checks `admin=true` / `admin=false`. Run through `Tools/box/test-login` |
| `save-session.mjs` | Opens a browser window; a person signs in to YouEye ID; the session goes to `.auth/<name>.json` (boxes without test accounts) |
| `warm-sessions.mjs` | Re-establishes the Control Panel sessions from the saved YouEye ID sessions and prints `admin=` for each (the session check) |
| `set-access.mjs` | `node set-access.mjs <app> all_users`: admit standard users (new apps are owner-only) |
| `app-round.sh` | Install / restart / remove harness for one app on the test box |
| `install-api.mjs` | Install an app through the Control Panel API as the admin, AI Settings off |
| `sign-in.mjs` | `node sign-in.mjs <app> off\|on`: turn an app's YouEye ID sign-in off/on (re-runs its `setup/sso.yaml`) |
| `connect-suggestions.mjs` | `node connect-suggestions.mjs [from>to …]`: list connection suggestions; approve the named ones (like Connect on a suggestion card) |
| `vaultwarden-probe.mjs` | Vaultwarden's flow up to the master-password step (types the account email only) |

## Prerequisites

- Node 24 (`~/.cache/youeye-build/node-24.22.0/bin` first on `PATH`), then `npm ci` and
  `npx playwright install chromium` once.
- A test box. Set `BOX_DOMAIN` to its domain (e.g. `export BOX_DOMAIN=<name>.ui.bingo`). For a domain that is not
  in DNS, such as `devvm.test` on a clone of the template VM, also set `BOX_IP` to the box's address: every script
  and the suite then map the domain and its subdomains to it and accept the box's internal TLS certificate. Always set
  it on a clone: the LAN's DNS may answer `devvm.test` with another box.
  A new script must do the same: `chromium.launch(launchOptions)`, `browser.newContext({ ...contextOptions, … })`
  (both from `lib.mjs`), and every request to the box from inside a page (`page.evaluate(fetch)`, `pageFetch`,
  `openControlPanel`) or with `lib.mjs`'s `probe()`. Playwright's Node-side `context.request` ignores the mapping: on a
  clone it would ask the LAN's DNS and send the saved session cookies to whichever box answers.
- Two YouEye ID users: an admin (default username `tester`, override `ADMIN_USERNAME`) and a standard user
  (`tester2`, override `USER_USERNAME`).
- Saved sessions (git-ignored, `.auth/`, files mode 0600; never print or commit them). On a test box an agent makes
  them with the YouEye Tools wrapper, which holds the standard test accounts (`tester` admin, `tester2` standard) and
  sets the variables:

  ```sh
  Tools/box/test-login <box-ip|domain> [--vm <id>] [--domain <d>]   # e.g. 192.168.31.57 --vm 161 (a template clone)
  ```

  It runs `node login.mjs` here with `YOUEYE_TEST_ADMIN_USER`/`_PASS` and `YOUEYE_TEST_USER_USER`/`_PASS`, one
  attempt per account (YouEye ID locks a username for 15 minutes after 10 failed sign-ins: never loop it), and
  prints `admin tester admin=true` and `user tester2 admin=false`.

  **Rules:** test boxes only (Andrew's VM 156, template clones, agent test VMs), YouEye ID test accounts only. An
  app's own generated admin password stays off-limits. Never on the owner's box: the wrapper refuses it by name and
  address. On a box without the test accounts a person signs in by hand instead:

  ```sh
  node save-session.mjs admin https://$BOX_DOMAIN   # sign in as the admin, close the window
  node save-session.mjs user  https://$BOX_DOMAIN   # sign in as the standard user
  node warm-sessions.mjs                                    # Control Panel sessions too, and the admin= check
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
