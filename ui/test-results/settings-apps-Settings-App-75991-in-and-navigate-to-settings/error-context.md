# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: settings-apps.spec.ts >> Settings Apps Restructure >> login and navigate to settings
- Location: tests/settings-apps.spec.ts:32:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('text=Profile')
Expected: visible
Error: strict mode violation: locator('text=Profile') resolved to 3 elements:
    1) <a href="/settings" class="flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors bg-accent text-accent-foreground font-medium">…</a> aka getByRole('link', { name: 'Profile' })
    2) <h2 class="text-xl font-semibold">Profile</h2> aka getByRole('heading', { name: 'Profile' })
    3) <p class="text-sm text-muted-foreground mt-1">Your profile information is managed by your ident…</p> aka getByText('Your profile information is')

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('text=Profile')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - link "DevVM" [ref=e5] [cursor=pointer]:
        - /url: /
        - generic [ref=e6]: DevVM
      - generic [ref=e7]:
        - link "Home" [ref=e8] [cursor=pointer]:
          - /url: /
          - img
        - button "Apps" [ref=e9] [cursor=pointer]:
          - img
        - button "Notifications" [ref=e11]:
          - img [ref=e12]
        - button "DT" [ref=e15]:
          - generic [ref=e17]: DT
    - generic [ref=e18]:
      - navigation [ref=e19]:
        - generic [ref=e20]:
          - link "Back to Dashboard" [ref=e21] [cursor=pointer]:
            - /url: /
            - img [ref=e22]
            - text: Back to Dashboard
          - link "Profile" [ref=e25] [cursor=pointer]:
            - /url: /settings
            - img [ref=e26]
            - text: Profile
          - link "Appearance" [ref=e29] [cursor=pointer]:
            - /url: /settings/appearance
            - img [ref=e30]
            - text: Appearance
          - link "Apps" [ref=e36] [cursor=pointer]:
            - /url: /settings/apps
            - img [ref=e37]
            - text: Apps
          - link "Accounts" [ref=e42] [cursor=pointer]:
            - /url: /settings/accounts
            - img [ref=e43]
            - text: Accounts
          - link "Timeline" [ref=e46] [cursor=pointer]:
            - /url: /timeline
            - img [ref=e47]
            - text: Timeline
          - link "Privacy" [ref=e50] [cursor=pointer]:
            - /url: /settings/privacy
            - img [ref=e51]
            - text: Privacy
          - link "Language" [ref=e53] [cursor=pointer]:
            - /url: /settings/language
            - img [ref=e54]
            - text: Language
          - link "Branding" [ref=e58] [cursor=pointer]:
            - /url: /settings/branding
            - img [ref=e59]
            - text: Branding
          - paragraph [ref=e64]: Admin
          - link "Users" [ref=e65] [cursor=pointer]:
            - /url: /settings/users
            - img [ref=e66]
            - text: Users
          - link "System" [ref=e71] [cursor=pointer]:
            - /url: /settings/system
            - img [ref=e72]
            - text: System
          - link "Containers" [ref=e75] [cursor=pointer]:
            - /url: /settings/containers
            - img [ref=e76]
            - text: Containers
          - link "DNS" [ref=e79] [cursor=pointer]:
            - /url: /settings/dns
            - img [ref=e80]
            - text: DNS
          - link "Proxy" [ref=e83] [cursor=pointer]:
            - /url: /settings/proxy
            - img [ref=e84]
            - text: Proxy
          - link "Backup" [ref=e87] [cursor=pointer]:
            - /url: /settings/backup
            - img [ref=e88]
            - text: Backup
          - link "App Management" [ref=e90] [cursor=pointer]:
            - /url: /settings/apps-list
            - img [ref=e91]
            - text: App Management
          - link "App Market" [ref=e95] [cursor=pointer]:
            - /url: /app-market
            - img [ref=e96]
            - text: App Market
      - main [ref=e100]:
        - generic [ref=e101]:
          - generic [ref=e102]:
            - heading "Profile" [level=2] [ref=e103]
            - paragraph [ref=e104]: Your profile information is managed by your identity provider.
          - generic [ref=e105]:
            - generic [ref=e106]:
              - generic [ref=e108]: DT
              - generic [ref=e109]:
                - paragraph [ref=e110]: Dev Tester
                - paragraph [ref=e111]: Administrator
            - generic [ref=e112]:
              - generic [ref=e113] [cursor=pointer]:
                - img [ref=e114]
                - text: Upload
              - button "Choose" [ref=e117]:
                - img [ref=e118]
                - text: Choose
          - iframe [ref=e123]:
            - generic [active] [ref=f1e1]:
              - generic [ref=f1e3]:
                - generic [ref=f1e4]:
                  - img [ref=f1e5]
                  - text: Account Name
                - generic [ref=f1e8]:
                  - generic [ref=f1e9]:
                    - generic [ref=f1e10]: First Name
                    - textbox "First name" [ref=f1e11]: Dev
                  - generic [ref=f1e12]:
                    - generic [ref=f1e13]: Last Name
                    - textbox "Last name" [ref=f1e14]: Tester
                - generic [ref=f1e15]:
                  - generic [ref=f1e16]:
                    - generic [ref=f1e17]: Username
                    - generic [ref=f1e18]: tester
                  - generic [ref=f1e19]:
                    - generic [ref=f1e20]: Email
                    - generic [ref=f1e21]: tester@devvm.test
                - button "Save Name" [disabled] [ref=f1e23]
                - generic [ref=f1e24]: ✦ Administrator
              - alert [ref=f1e25]
          - generic [ref=e124]:
            - generic [ref=e125]:
              - generic [ref=e126]:
                - img [ref=e127]
                - text: Bio
              - textbox "Tell us about yourself..." [ref=e130]
            - generic [ref=e131]:
              - generic [ref=e132]:
                - img [ref=e133]
                - text: Timezone
              - combobox [ref=e136]:
                - option "Africa/Abidjan" [selected]
                - option "Africa/Accra"
                - option "Africa/Addis_Ababa"
                - option "Africa/Algiers"
                - option "Africa/Asmera"
                - option "Africa/Bamako"
                - option "Africa/Bangui"
                - option "Africa/Banjul"
                - option "Africa/Bissau"
                - option "Africa/Blantyre"
                - option "Africa/Brazzaville"
                - option "Africa/Bujumbura"
                - option "Africa/Cairo"
                - option "Africa/Casablanca"
                - option "Africa/Ceuta"
                - option "Africa/Conakry"
                - option "Africa/Dakar"
                - option "Africa/Dar_es_Salaam"
                - option "Africa/Djibouti"
                - option "Africa/Douala"
                - option "Africa/El_Aaiun"
                - option "Africa/Freetown"
                - option "Africa/Gaborone"
                - option "Africa/Harare"
                - option "Africa/Johannesburg"
                - option "Africa/Juba"
                - option "Africa/Kampala"
                - option "Africa/Khartoum"
                - option "Africa/Kigali"
                - option "Africa/Kinshasa"
                - option "Africa/Lagos"
                - option "Africa/Libreville"
                - option "Africa/Lome"
                - option "Africa/Luanda"
                - option "Africa/Lubumbashi"
                - option "Africa/Lusaka"
                - option "Africa/Malabo"
                - option "Africa/Maputo"
                - option "Africa/Maseru"
                - option "Africa/Mbabane"
                - option "Africa/Mogadishu"
                - option "Africa/Monrovia"
                - option "Africa/Nairobi"
                - option "Africa/Ndjamena"
                - option "Africa/Niamey"
                - option "Africa/Nouakchott"
                - option "Africa/Ouagadougou"
                - option "Africa/Porto-Novo"
                - option "Africa/Sao_Tome"
                - option "Africa/Tripoli"
                - option "Africa/Tunis"
                - option "Africa/Windhoek"
                - option "America/Adak"
                - option "America/Anchorage"
                - option "America/Anguilla"
                - option "America/Antigua"
                - option "America/Araguaina"
                - option "America/Argentina/La_Rioja"
                - option "America/Argentina/Rio_Gallegos"
                - option "America/Argentina/Salta"
                - option "America/Argentina/San_Juan"
                - option "America/Argentina/San_Luis"
                - option "America/Argentina/Tucuman"
                - option "America/Argentina/Ushuaia"
                - option "America/Aruba"
                - option "America/Asuncion"
                - option "America/Bahia"
                - option "America/Bahia_Banderas"
                - option "America/Barbados"
                - option "America/Belem"
                - option "America/Belize"
                - option "America/Blanc-Sablon"
                - option "America/Boa_Vista"
                - option "America/Bogota"
                - option "America/Boise"
                - option "America/Buenos_Aires"
                - option "America/Cambridge_Bay"
                - option "America/Campo_Grande"
                - option "America/Cancun"
                - option "America/Caracas"
                - option "America/Catamarca"
                - option "America/Cayenne"
                - option "America/Cayman"
                - option "America/Chicago"
                - option "America/Chihuahua"
                - option "America/Ciudad_Juarez"
                - option "America/Coral_Harbour"
                - option "America/Cordoba"
                - option "America/Costa_Rica"
                - option "America/Coyhaique"
                - option "America/Creston"
                - option "America/Cuiaba"
                - option "America/Curacao"
                - option "America/Danmarkshavn"
                - option "America/Dawson"
                - option "America/Dawson_Creek"
                - option "America/Denver"
                - option "America/Detroit"
                - option "America/Dominica"
                - option "America/Edmonton"
                - option "America/Eirunepe"
                - option "America/El_Salvador"
                - option "America/Fort_Nelson"
                - option "America/Fortaleza"
                - option "America/Glace_Bay"
                - option "America/Godthab"
                - option "America/Goose_Bay"
                - option "America/Grand_Turk"
                - option "America/Grenada"
                - option "America/Guadeloupe"
                - option "America/Guatemala"
                - option "America/Guayaquil"
                - option "America/Guyana"
                - option "America/Halifax"
                - option "America/Havana"
                - option "America/Hermosillo"
                - option "America/Indiana/Knox"
                - option "America/Indiana/Marengo"
                - option "America/Indiana/Petersburg"
                - option "America/Indiana/Tell_City"
                - option "America/Indiana/Vevay"
                - option "America/Indiana/Vincennes"
                - option "America/Indiana/Winamac"
                - option "America/Indianapolis"
                - option "America/Inuvik"
                - option "America/Iqaluit"
                - option "America/Jamaica"
                - option "America/Jujuy"
                - option "America/Juneau"
                - option "America/Kentucky/Monticello"
                - option "America/Kralendijk"
                - option "America/La_Paz"
                - option "America/Lima"
                - option "America/Los_Angeles"
                - option "America/Louisville"
                - option "America/Lower_Princes"
                - option "America/Maceio"
                - option "America/Managua"
                - option "America/Manaus"
                - option "America/Marigot"
                - option "America/Martinique"
                - option "America/Matamoros"
                - option "America/Mazatlan"
                - option "America/Mendoza"
                - option "America/Menominee"
                - option "America/Merida"
                - option "America/Metlakatla"
                - option "America/Mexico_City"
                - option "America/Miquelon"
                - option "America/Moncton"
                - option "America/Monterrey"
                - option "America/Montevideo"
                - option "America/Montserrat"
                - option "America/Nassau"
                - option "America/New_York"
                - option "America/Nome"
                - option "America/Noronha"
                - option "America/North_Dakota/Beulah"
                - option "America/North_Dakota/Center"
                - option "America/North_Dakota/New_Salem"
                - option "America/Ojinaga"
                - option "America/Panama"
                - option "America/Paramaribo"
                - option "America/Phoenix"
                - option "America/Port-au-Prince"
                - option "America/Port_of_Spain"
                - option "America/Porto_Velho"
                - option "America/Puerto_Rico"
                - option "America/Punta_Arenas"
                - option "America/Rankin_Inlet"
                - option "America/Recife"
                - option "America/Regina"
                - option "America/Resolute"
                - option "America/Rio_Branco"
                - option "America/Santarem"
                - option "America/Santiago"
                - option "America/Santo_Domingo"
                - option "America/Sao_Paulo"
                - option "America/Scoresbysund"
                - option "America/Sitka"
                - option "America/St_Barthelemy"
                - option "America/St_Johns"
                - option "America/St_Kitts"
                - option "America/St_Lucia"
                - option "America/St_Thomas"
                - option "America/St_Vincent"
                - option "America/Swift_Current"
                - option "America/Tegucigalpa"
                - option "America/Thule"
                - option "America/Tijuana"
                - option "America/Toronto"
                - option "America/Tortola"
                - option "America/Vancouver"
                - option "America/Whitehorse"
                - option "America/Winnipeg"
                - option "America/Yakutat"
                - option "Antarctica/Casey"
                - option "Antarctica/Davis"
                - option "Antarctica/DumontDUrville"
                - option "Antarctica/Macquarie"
                - option "Antarctica/Mawson"
                - option "Antarctica/McMurdo"
                - option "Antarctica/Palmer"
                - option "Antarctica/Rothera"
                - option "Antarctica/Syowa"
                - option "Antarctica/Troll"
                - option "Antarctica/Vostok"
                - option "Arctic/Longyearbyen"
                - option "Asia/Aden"
                - option "Asia/Almaty"
                - option "Asia/Amman"
                - option "Asia/Anadyr"
                - option "Asia/Aqtau"
                - option "Asia/Aqtobe"
                - option "Asia/Ashgabat"
                - option "Asia/Atyrau"
                - option "Asia/Baghdad"
                - option "Asia/Bahrain"
                - option "Asia/Baku"
                - option "Asia/Bangkok"
                - option "Asia/Barnaul"
                - option "Asia/Beirut"
                - option "Asia/Bishkek"
                - option "Asia/Brunei"
                - option "Asia/Calcutta"
                - option "Asia/Chita"
                - option "Asia/Colombo"
                - option "Asia/Damascus"
                - option "Asia/Dhaka"
                - option "Asia/Dili"
                - option "Asia/Dubai"
                - option "Asia/Dushanbe"
                - option "Asia/Famagusta"
                - option "Asia/Gaza"
                - option "Asia/Hebron"
                - option "Asia/Hong_Kong"
                - option "Asia/Hovd"
                - option "Asia/Irkutsk"
                - option "Asia/Jakarta"
                - option "Asia/Jayapura"
                - option "Asia/Jerusalem"
                - option "Asia/Kabul"
                - option "Asia/Kamchatka"
                - option "Asia/Karachi"
                - option "Asia/Katmandu"
                - option "Asia/Khandyga"
                - option "Asia/Krasnoyarsk"
                - option "Asia/Kuala_Lumpur"
                - option "Asia/Kuching"
                - option "Asia/Kuwait"
                - option "Asia/Macau"
                - option "Asia/Magadan"
                - option "Asia/Makassar"
                - option "Asia/Manila"
                - option "Asia/Muscat"
                - option "Asia/Nicosia"
                - option "Asia/Novokuznetsk"
                - option "Asia/Novosibirsk"
                - option "Asia/Omsk"
                - option "Asia/Oral"
                - option "Asia/Phnom_Penh"
                - option "Asia/Pontianak"
                - option "Asia/Pyongyang"
                - option "Asia/Qatar"
                - option "Asia/Qostanay"
                - option "Asia/Qyzylorda"
                - option "Asia/Rangoon"
                - option "Asia/Riyadh"
                - option "Asia/Saigon"
                - option "Asia/Sakhalin"
                - option "Asia/Samarkand"
                - option "Asia/Seoul"
                - option "Asia/Shanghai"
                - option "Asia/Singapore"
                - option "Asia/Srednekolymsk"
                - option "Asia/Taipei"
                - option "Asia/Tashkent"
                - option "Asia/Tbilisi"
                - option "Asia/Tehran"
                - option "Asia/Thimphu"
                - option "Asia/Tokyo"
                - option "Asia/Tomsk"
                - option "Asia/Ulaanbaatar"
                - option "Asia/Urumqi"
                - option "Asia/Ust-Nera"
                - option "Asia/Vientiane"
                - option "Asia/Vladivostok"
                - option "Asia/Yakutsk"
                - option "Asia/Yekaterinburg"
                - option "Asia/Yerevan"
                - option "Atlantic/Azores"
                - option "Atlantic/Bermuda"
                - option "Atlantic/Canary"
                - option "Atlantic/Cape_Verde"
                - option "Atlantic/Faeroe"
                - option "Atlantic/Madeira"
                - option "Atlantic/Reykjavik"
                - option "Atlantic/South_Georgia"
                - option "Atlantic/St_Helena"
                - option "Atlantic/Stanley"
                - option "Australia/Adelaide"
                - option "Australia/Brisbane"
                - option "Australia/Broken_Hill"
                - option "Australia/Darwin"
                - option "Australia/Eucla"
                - option "Australia/Hobart"
                - option "Australia/Lindeman"
                - option "Australia/Lord_Howe"
                - option "Australia/Melbourne"
                - option "Australia/Perth"
                - option "Australia/Sydney"
                - option "Europe/Amsterdam"
                - option "Europe/Andorra"
                - option "Europe/Astrakhan"
                - option "Europe/Athens"
                - option "Europe/Belgrade"
                - option "Europe/Berlin"
                - option "Europe/Bratislava"
                - option "Europe/Brussels"
                - option "Europe/Bucharest"
                - option "Europe/Budapest"
                - option "Europe/Busingen"
                - option "Europe/Chisinau"
                - option "Europe/Copenhagen"
                - option "Europe/Dublin"
                - option "Europe/Gibraltar"
                - option "Europe/Guernsey"
                - option "Europe/Helsinki"
                - option "Europe/Isle_of_Man"
                - option "Europe/Istanbul"
                - option "Europe/Jersey"
                - option "Europe/Kaliningrad"
                - option "Europe/Kiev"
                - option "Europe/Kirov"
                - option "Europe/Lisbon"
                - option "Europe/Ljubljana"
                - option "Europe/London"
                - option "Europe/Luxembourg"
                - option "Europe/Madrid"
                - option "Europe/Malta"
                - option "Europe/Mariehamn"
                - option "Europe/Minsk"
                - option "Europe/Monaco"
                - option "Europe/Moscow"
                - option "Europe/Oslo"
                - option "Europe/Paris"
                - option "Europe/Podgorica"
                - option "Europe/Prague"
                - option "Europe/Riga"
                - option "Europe/Rome"
                - option "Europe/Samara"
                - option "Europe/San_Marino"
                - option "Europe/Sarajevo"
                - option "Europe/Saratov"
                - option "Europe/Simferopol"
                - option "Europe/Skopje"
                - option "Europe/Sofia"
                - option "Europe/Stockholm"
                - option "Europe/Tallinn"
                - option "Europe/Tirane"
                - option "Europe/Ulyanovsk"
                - option "Europe/Vaduz"
                - option "Europe/Vatican"
                - option "Europe/Vienna"
                - option "Europe/Vilnius"
                - option "Europe/Volgograd"
                - option "Europe/Warsaw"
                - option "Europe/Zagreb"
                - option "Europe/Zurich"
                - option "Indian/Antananarivo"
                - option "Indian/Chagos"
                - option "Indian/Christmas"
                - option "Indian/Cocos"
                - option "Indian/Comoro"
                - option "Indian/Kerguelen"
                - option "Indian/Mahe"
                - option "Indian/Maldives"
                - option "Indian/Mauritius"
                - option "Indian/Mayotte"
                - option "Indian/Reunion"
                - option "Pacific/Apia"
                - option "Pacific/Auckland"
                - option "Pacific/Bougainville"
                - option "Pacific/Chatham"
                - option "Pacific/Easter"
                - option "Pacific/Efate"
                - option "Pacific/Enderbury"
                - option "Pacific/Fakaofo"
                - option "Pacific/Fiji"
                - option "Pacific/Funafuti"
                - option "Pacific/Galapagos"
                - option "Pacific/Gambier"
                - option "Pacific/Guadalcanal"
                - option "Pacific/Guam"
                - option "Pacific/Honolulu"
                - option "Pacific/Kiritimati"
                - option "Pacific/Kosrae"
                - option "Pacific/Kwajalein"
                - option "Pacific/Majuro"
                - option "Pacific/Marquesas"
                - option "Pacific/Midway"
                - option "Pacific/Nauru"
                - option "Pacific/Niue"
                - option "Pacific/Norfolk"
                - option "Pacific/Noumea"
                - option "Pacific/Pago_Pago"
                - option "Pacific/Palau"
                - option "Pacific/Pitcairn"
                - option "Pacific/Ponape"
                - option "Pacific/Port_Moresby"
                - option "Pacific/Rarotonga"
                - option "Pacific/Saipan"
                - option "Pacific/Tahiti"
                - option "Pacific/Tarawa"
                - option "Pacific/Tongatapu"
                - option "Pacific/Truk"
                - option "Pacific/Wake"
                - option "Pacific/Wallis"
            - button "Save" [ref=e138]:
              - img [ref=e139]
              - text: Save
            - paragraph [ref=e143]: "User ID: 4c2bfe6d-ca8f-4c53-a2bd-dda6a4756f47"
  - region "Notifications alt+T"
  - alert [ref=e144]
```

# Test source

```ts
  1   | /**
  2   |  * Settings Apps — Playwright test suite
  3   |  *
  4   |  * Tests the Settings restructure (Session A):
  5   |  * - Sidebar shows "Apps" and "Accounts" instead of "Connectors"
  6   |  * - Admin sidebar shows "App Management" instead of "Apps"
  7   |  * - /settings/connectors redirects to /settings/apps
  8   |  * - Apps list page loads and shows installed apps
  9   |  * - Per-app detail page has 3 tabs: Data Sources, Link Handling, Permissions
  10  |  * - Accounts page loads with Connected Accounts and API Keys sections
  11  |  */
  12  | 
  13  | import { test, expect, chromium } from '@playwright/test';
  14  | 
  15  | const BASE = 'https://devvm.test';
  16  | 
  17  | test.describe('Settings Apps Restructure', () => {
  18  |   let browser: any;
  19  |   let context: any;
  20  |   let page: any;
  21  | 
  22  |   test.beforeAll(async () => {
  23  |     browser = await chromium.connectOverCDP('http://localhost:9222');
  24  |     context = await browser.newContext({ ignoreHTTPSErrors: true });
  25  |     page = await context.newPage();
  26  |   });
  27  | 
  28  |   test.afterAll(async () => {
  29  |     await context?.close();
  30  |   });
  31  | 
  32  |   test('login and navigate to settings', async () => {
  33  |     await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  34  | 
  35  |     // Handle SSO login if needed
  36  |     if (page.url().includes('authentik') || page.url().includes('/if/flow/')) {
  37  |       await page.locator('input[name="uidField"]').fill('tester');
  38  |       await page.locator('button[type="submit"]').click();
  39  |       await page.waitForTimeout(1000);
  40  |       await page.locator('input[name="password"]').fill('tester123');
  41  |       await page.locator('button[type="submit"]').click();
  42  |       await page.waitForURL(`${BASE}/**`, { timeout: 30000 });
  43  |     }
  44  | 
  45  |     // Navigate to settings via avatar menu
  46  |     await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle', timeout: 15000 });
> 47  |     await expect(page.locator('text=Profile')).toBeVisible({ timeout: 10000 });
      |                                                ^ Error: expect(locator).toBeVisible() failed
  48  |   });
  49  | 
  50  |   test('sidebar shows Apps instead of Connectors', async () => {
  51  |     // "Apps" should be visible in sidebar
  52  |     const appsLink = page.locator('nav a[href="/settings/apps"]');
  53  |     await expect(appsLink).toBeVisible();
  54  |     await expect(appsLink).toContainText('Apps');
  55  | 
  56  |     // Old "Connectors" link should NOT exist
  57  |     const connectorsLink = page.locator('nav a[href="/settings/connectors"]');
  58  |     await expect(connectorsLink).toHaveCount(0);
  59  |   });
  60  | 
  61  |   test('sidebar shows Accounts section', async () => {
  62  |     const accountsLink = page.locator('nav a[href="/settings/accounts"]');
  63  |     await expect(accountsLink).toBeVisible();
  64  |     await expect(accountsLink).toContainText('Accounts');
  65  |   });
  66  | 
  67  |   test('admin sidebar shows App Management', async () => {
  68  |     const appMgmtLink = page.locator('nav a[href="/settings/apps-list"]');
  69  |     await expect(appMgmtLink).toBeVisible();
  70  |     await expect(appMgmtLink).toContainText('App Management');
  71  |   });
  72  | 
  73  |   test('/settings/connectors redirects to /settings/apps', async () => {
  74  |     await page.goto(`${BASE}/settings/connectors`, { waitUntil: 'networkidle', timeout: 15000 });
  75  |     await page.waitForTimeout(1000);
  76  |     expect(page.url()).toContain('/settings/apps');
  77  |     expect(page.url()).not.toContain('/settings/connectors');
  78  |   });
  79  | 
  80  |   test('Apps list page shows installed apps', async () => {
  81  |     await page.goto(`${BASE}/settings/apps`, { waitUntil: 'networkidle', timeout: 15000 });
  82  | 
  83  |     // Page title
  84  |     await expect(page.locator('h2:has-text("Apps")')).toBeVisible({ timeout: 10000 });
  85  | 
  86  |     // Wait for app list to load
  87  |     await page.waitForTimeout(2000);
  88  | 
  89  |     // Should show at least Search app
  90  |     await expect(page.locator('text=Search')).toBeVisible({ timeout: 10000 });
  91  | 
  92  |     // Should show multiple native apps
  93  |     const appNames = ['Weather', 'Wiki', 'Notes', 'Translate', 'Cinema'];
  94  |     for (const name of appNames) {
  95  |       await expect(page.locator(`button:has-text("${name}")`).first()).toBeVisible({ timeout: 5000 });
  96  |     }
  97  |   });
  98  | 
  99  |   test('clicking an app navigates to per-app detail page', async () => {
  100 |     // Click on Search app
  101 |     await page.locator('button:has-text("Search")').first().click();
  102 |     await page.waitForTimeout(2000);
  103 | 
  104 |     // Should show app header
  105 |     await expect(page.locator('h2:has-text("Search")')).toBeVisible({ timeout: 10000 });
  106 | 
  107 |     // Should show "Back to Apps" link
  108 |     await expect(page.locator('text=Back to Apps')).toBeVisible();
  109 |   });
  110 | 
  111 |   test('per-app page has 3 tabs', async () => {
  112 |     // Data Sources tab should be visible and active
  113 |     const dsTab = page.locator('button:has-text("Data Sources")');
  114 |     await expect(dsTab).toBeVisible();
  115 | 
  116 |     // Link Handling tab
  117 |     const lhTab = page.locator('button:has-text("Link Handling")');
  118 |     await expect(lhTab).toBeVisible();
  119 | 
  120 |     // Permissions tab
  121 |     const permTab = page.locator('button:has-text("Permissions")');
  122 |     await expect(permTab).toBeVisible();
  123 |   });
  124 | 
  125 |   test('Data Sources tab shows connector capabilities', async () => {
  126 |     // Should show connections section on Data Sources tab
  127 |     await expect(page.locator('text=CONNECTIONS').first()).toBeVisible({ timeout: 5000 });
  128 |   });
  129 | 
  130 |   test('Link Handling tab shows placeholder', async () => {
  131 |     await page.locator('button:has-text("Link Handling")').click();
  132 |     await page.waitForTimeout(500);
  133 | 
  134 |     await expect(page.locator('text=No link handlers configured')).toBeVisible({ timeout: 5000 });
  135 |   });
  136 | 
  137 |   test('Permissions tab shows permission state', async () => {
  138 |     await page.locator('button:has-text("Permissions")').click();
  139 |     await page.waitForTimeout(1000);
  140 | 
  141 |     // Should show either permissions or "No permissions granted" message
  142 |     const hasPermissions = await page.locator('text=No permissions granted').isVisible().catch(() => false);
  143 |     const hasGranted = await page.locator('text=granted').isVisible().catch(() => false);
  144 |     expect(hasPermissions || hasGranted).toBeTruthy();
  145 |   });
  146 | 
  147 |   test('Back to Apps link works', async () => {
```