package cmd

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
)

// marketSourcesFixture is GET /api/market/source as the Control Panel answers it.
const marketSourcesFixture = `{
  "sources": [
    {"id": "official", "name": "YouEye Market", "kind": "official", "url": "", "enabled": true, "priority": 0,
     "address": "https://market.youeye.me/dev/",
     "market": {"address": "https://market.youeye.me/dev/", "name": "YouEye Market", "publisher": "YouEye",
                "commit": "0123456789abcdef0123456789abcdef01234567", "sequence": 1763460000,
                "sequence_date": "2025-11-18T10:00:00.000Z", "apps": 29, "apps_with_setup": 4, "native": 6, "bundles": 2},
     "accepted_market_at": "2026-11-18T09:00:00.000Z", "refreshed_at": "2026-11-18T10:05:00.000Z",
     "checked_at": "2026-11-18T10:05:00.000Z"},
    {"id": "custom-1", "name": "apps.example.org", "kind": "url", "url": "https://apps.example.org/market/",
     "enabled": true, "priority": 1, "accepted_at": "2026-11-18T08:30:00.000Z",
     "address": "https://apps.example.org/market/",
     "market": {"address": "https://apps.example.org/market/", "name": "Totally Official Apps", "publisher": "Example",
                "sequence": 1763450000, "sequence_date": "2025-11-18T07:13:20.000Z", "apps": 3, "apps_with_setup": 1,
                "native": 0, "bundles": 0},
     "accepted_market_at": "2026-11-18T08:30:00.000Z", "refreshed_at": "2026-11-18T08:30:00.000Z",
     "checked_at": "2026-11-18T10:05:00.000Z", "refresh_error": "market.json could not be fetched (HTTP 503)"},
    {"id": "andrew", "name": "Andrew", "kind": "url", "url": "https://andrew.example.net/", "enabled": false,
     "priority": 2, "address": "https://andrew.example.net/", "market": null, "accepted_market_at": null,
     "refreshed_at": null, "checked_at": null}
  ],
  "removed_sources": [
    {"id": "andrew-test", "name": "Andrew test", "address": "https://git.example/a/M", "branch": "dev",
     "removed_at": "2026-11-18T07:00:00.000Z"}
  ]
}`

func decodeFixture(t *testing.T, raw string) map[string]interface{} {
	t.Helper()
	var data map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		t.Fatal(err)
	}
	return data
}

// captureStdout returns what run prints (the output package prints to stdout).
func captureStdout(t *testing.T, run func()) string {
	t.Helper()
	old := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	done := make(chan string)
	go func() {
		raw, _ := io.ReadAll(reader)
		done <- string(raw)
	}()
	defer func() { os.Stdout = old }()
	run()
	writer.Close()
	return <-done
}

func TestMarketListRows(t *testing.T) {
	data := decodeFixture(t, marketSourcesFixture)
	rows := marketListRows(data)
	want := [][]string{
		{"official", "YouEye Market", "https://market.youeye.me/dev/", `"YouEye Market" by "YouEye"`, "0123456", "2025-11-18 10:00Z", "29", "yes", "official", "2026-11-18 10:05Z"},
		{"custom-1", "apps.example.org", "https://apps.example.org/market/", `"Totally Official Apps" by "Example"`, "", "2025-11-18 07:13Z", "3", "yes", "2026-11-18 08:30Z", "failed (see below)"},
		{"andrew", "Andrew", "https://andrew.example.net/", "-", "", "", "", "no", "no", "never"},
	}
	if len(rows) != len(want) {
		t.Fatalf("rows: %q", rows)
	}
	for i := range want {
		if strings.Join(rows[i], "|") != strings.Join(want[i], "|") {
			t.Errorf("row %d:\n got %q\nwant %q", i, rows[i], want[i])
		}
	}
	problems := marketRefreshErrors(data)
	if len(problems) != 1 || problems[0] != "custom-1: the last refresh failed at 2026-11-18 10:05Z: market.json could not be fetched (HTTP 503)" {
		t.Errorf("refresh errors: %q", problems)
	}
	removed := removedMarketLines(data)
	if len(removed) != 1 || removed[0] != "andrew-test  Andrew test  https://git.example/a/M (branch dev)  removed 2026-11-18 07:00Z" {
		t.Errorf("removed: %q", removed)
	}
	printed := captureStdout(t, func() { printMarketList(data) })
	for _, part := range []string{"MARKET SAYS", "LAST REFRESH", "Totally Official Apps", "were removed", "andrew-test"} {
		if !strings.Contains(printed, part) {
			t.Errorf("market list output lacks %q:\n%s", part, printed)
		}
	}
	t.Logf("youeye market list:\n%s", printed)
	if removedMarketLines(map[string]interface{}{"removed_sources": []interface{}{}}) == nil ||
		strings.Contains(captureStdout(t, func() { printMarketList(map[string]interface{}{"sources": []interface{}{}}) }), "removed") {
		t.Error("no removed sources must print no note")
	}
}

// The command tree has one spelling of each thing; the git-era commands are gone.
func TestMarketCommandTree(t *testing.T) {
	for _, name := range []string{"list", "add", "remove", "accept", "refresh", "search", "info", "official-lane"} {
		if c, _, err := rootCmd.Find([]string{"market", name}); err != nil || c.Name() != name {
			t.Errorf("youeye market %s is missing", name)
		}
	}
	for _, gone := range [][]string{{"market", "source", "list"}, {"market", "source", "accept"}, {"market", "repo", "set"}, {"market", "repo", "get"}} {
		if c, _, _ := rootCmd.Find(gone); c != nil && c.Name() != "market" {
			t.Errorf("youeye %s still resolves to %q", strings.Join(gone, " "), c.CommandPath())
		}
	}
	got := []string{}
	for _, c := range marketCmd.Commands() {
		got = append(got, c.Name())
	}
	if strings.Join(got, " ") != "accept add info list official-lane refresh remove search" {
		t.Errorf("market subcommands: %v", got)
	}
}

// The official Market's lane (YE-142): main or dev, read from the official source; no lane is main.
func TestMarketOfficialLane(t *testing.T) {
	for _, lane := range []string{"main", "dev"} {
		if err := validateOfficialLane(lane); err != nil {
			t.Errorf("%s refused: %v", lane, err)
		}
	}
	for _, lane := range []string{"", "stable", "alpha", "test/native", "Main"} {
		if validateOfficialLane(lane) == nil {
			t.Errorf("%q accepted", lane)
		}
	}
	list := func(official map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"sources": []interface{}{official, map[string]interface{}{"id": "custom-1", "kind": "url", "lane": "dev"}}}
	}
	if got := officialLaneOf(list(map[string]interface{}{"id": "official", "kind": "official"})); got != "main" {
		t.Errorf("no lane read as %s", got)
	}
	if got := officialLaneOf(list(map[string]interface{}{"id": "official", "kind": "official", "lane": "dev"})); got != "dev" {
		t.Errorf("dev read as %s", got)
	}
	if officialLaneAddress("dev") != "https://market.youeye.me/dev/" || officialLaneAddress("main") != "https://market.youeye.me/" {
		t.Error("lane addresses")
	}
	if c, _, err := rootCmd.Find([]string{"market", "official-lane"}); err != nil || c.Args(c, []string{"main", "dev"}) == nil {
		t.Error("official-lane takes at most one lane")
	}
}

func TestMarketArgs(t *testing.T) {
	cases := []struct {
		cmd  *cobra.Command
		args []string
		ok   bool
	}{
		{marketListCmd, nil, true},
		{marketListCmd, []string{"x"}, false},
		{marketAddCmd, nil, false},
		{marketAddCmd, []string{"https://apps.example.org/"}, true},
		{marketAddCmd, []string{"a", "b"}, false},
		{marketRemoveCmd, nil, false},
		{marketRemoveCmd, []string{"custom-1"}, true},
		{marketAcceptCmd, []string{"custom-1"}, true},
		{marketAcceptCmd, nil, false},
		{marketRefreshCmd, nil, true},
		{marketRefreshCmd, []string{"custom-1"}, true},
		{marketRefreshCmd, []string{"a", "b"}, false},
		{marketSearchCmd, nil, false},
		{marketSearchCmd, []string{"notes"}, true},
		{marketInfoCmd, []string{"notes"}, true},
		{marketInfoCmd, nil, false},
	}
	for _, c := range cases {
		if err := c.cmd.Args(c.cmd, c.args); (err == nil) != c.ok {
			t.Errorf("%s %v: err=%v", c.cmd.CommandPath(), c.args, err)
		}
	}
	if marketAddCmd.Flags().Lookup("i-trust-this-market") == nil || marketAddCmd.Flags().Lookup("name") == nil || marketInfoCmd.Flags().Lookup("source") == nil {
		t.Error("a flag is missing")
	}
}

// fakeControlPanel records the requests the CLI sends (method, path, body) and answers from routes.
type fakeControlPanel struct {
	mu       sync.Mutex
	requests []string
	routes   map[string]func(body string) (int, string)
}

func (f *fakeControlPanel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/ping" {
		return
	}
	body, _ := io.ReadAll(r.Body)
	key := r.Method + " " + r.URL.RequestURI()
	f.mu.Lock()
	f.requests = append(f.requests, strings.TrimSpace(key+" "+string(body)))
	route := f.routes[key]
	f.mu.Unlock()
	if r.Header.Get("X-CLI-Token") != "test-token" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if route == nil {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"no route ` + key + `"}`))
		return
	}
	status, answer := route(string(body))
	w.WriteHeader(status)
	_, _ = w.Write([]byte(answer))
}

func (f *fakeControlPanel) take() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	requests := f.requests
	f.requests = nil
	return requests
}

func useFakeControlPanel(t *testing.T, routes map[string]func(body string) (int, string)) *fakeControlPanel {
	t.Helper()
	fake := &fakeControlPanel{routes: routes}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	old := controlClient
	controlClient = controlapi.NewClientAt(server.URL, "test-token")
	t.Cleanup(func() { controlClient = old })
	return fake
}

func answer(status int, body string) func(string) (int, string) {
	return func(string) (int, string) { return status, body }
}

func checkSent(t *testing.T, fake *fakeControlPanel, want ...string) {
	t.Helper()
	got := fake.take()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestMarketAddRequest(t *testing.T) {
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"POST /api/market/source": answer(200, `{"status":"ok","source":{"id":"custom-1","address":"https://apps.example.org/market/",
			"market":{"name":"Totally Official Apps","publisher":"Example","apps":3,"apps_with_setup":1}}}`),
	})
	t.Cleanup(func() { marketAddTrusted, marketAddName = false, "" })

	// Without the flag: the warning, a failure, and nothing sent.
	marketAddTrusted, marketAddName = false, ""
	var err error
	printed := captureStdout(t, func() { err = marketAddCmd.RunE(marketAddCmd, []string{"https://apps.example.org/market/"}) })
	if err == nil || !strings.Contains(err.Error(), "--i-trust-this-market") || !strings.Contains(printed, marketTrustWarning) {
		t.Fatalf("add without the flag: %v\n%s", err, printed)
	}
	checkSent(t, fake)

	marketAddTrusted, marketAddName = true, ""
	printed = captureStdout(t, func() { err = marketAddCmd.RunE(marketAddCmd, []string{" https://apps.example.org/market/ "}) })
	if err != nil || !strings.Contains(printed, "custom-1 added") || !strings.Contains(printed, `"Totally Official Apps" by "Example"`) {
		t.Fatalf("add: %v\n%s", err, printed)
	}
	checkSent(t, fake, `POST /api/market/source {"acceptRisk":true,"url":"https://apps.example.org/market/"}`)

	marketAddName = "Friends"
	captureStdout(t, func() { err = marketAddCmd.RunE(marketAddCmd, []string{"https://apps.example.org/market/"}) })
	if err != nil {
		t.Fatal(err)
	}
	checkSent(t, fake, `POST /api/market/source {"acceptRisk":true,"name":"Friends","url":"https://apps.example.org/market/"}`)

	// A refusal is shown by its message, not as a response body.
	fake.routes["POST /api/market/source"] = answer(400, `{"error":"This market is already a Market source"}`)
	captureStdout(t, func() { err = marketAddCmd.RunE(marketAddCmd, []string{"https://apps.example.org/market/"}) })
	if err == nil || err.Error() != "This market is already a Market source" {
		t.Fatalf("refusal: %v", err)
	}
}

func TestMarketRemoveRequest(t *testing.T) {
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"GET /api/market/source":   answer(200, marketSourcesFixture),
		"PATCH /api/market/source": answer(200, `{"status":"ok","sources":[]}`),
	})
	var err error
	captureStdout(t, func() { err = marketRemoveCmd.RunE(marketRemoveCmd, []string{"custom-1"}) })
	if err != nil {
		t.Fatal(err)
	}
	checkSent(t, fake, "GET /api/market/source", `PATCH /api/market/source {"active_sources":[{"id":"official"},{"id":"andrew"}]}`)

	if err = marketRemoveCmd.RunE(marketRemoveCmd, []string{"official"}); err == nil || !strings.Contains(err.Error(), "official Market cannot be removed") {
		t.Fatalf("official removed: %v", err)
	}
	captureStdout(t, func() { err = marketRemoveCmd.RunE(marketRemoveCmd, []string{"nope"}) })
	if err == nil || !strings.Contains(err.Error(), `no market "nope"`) {
		t.Fatalf("unknown market: %v", err)
	}
	checkSent(t, fake, "GET /api/market/source")
}

func TestMarketAcceptAndRefreshRequests(t *testing.T) {
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"POST /api/market/source/accept": answer(200, `{"status":"ok","source":{"id":"custom-1","url":"https://apps.example.org/market/"}}`),
		"POST /api/market/source/refresh": answer(200, `{"status":"ok","results":[
			{"id":"official","ok":true,"sequence":1763460000,"commit":"0123456789abcdef"},
			{"id":"custom-1","ok":false,"error":"market.json could not be fetched (HTTP 503)"}]}`),
	})
	var err error
	printed := captureStdout(t, func() { err = marketAcceptCmd.RunE(marketAcceptCmd, []string{"custom-1"}) })
	if err != nil || !strings.Contains(printed, "custom-1 (https://apps.example.org/market/) accepted") {
		t.Fatalf("accept: %v\n%s", err, printed)
	}
	checkSent(t, fake, `POST /api/market/source/accept {"id":"custom-1"}`)

	printed = captureStdout(t, func() { err = marketRefreshCmd.RunE(marketRefreshCmd, nil) })
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Code != 1 {
		t.Fatalf("a failed refresh must fail the command: %v", err)
	}
	if !strings.Contains(printed, "official: up to date (commit 0123456, 2025-11-18 10:00Z)") || !strings.Contains(printed, "custom-1: market.json could not be fetched (HTTP 503)") {
		t.Fatalf("refresh output:\n%s", printed)
	}
	checkSent(t, fake, "GET /api/market/source", `POST /api/market/source/refresh {}`)

	// A market whose state moved says so; one that has the same state as before is up to date.
	fake.routes["GET /api/market/source"] = answer(200, `{"sources":[{"id":"official","market":{"sequence":1763460000}},
		{"id":"custom-1","market":{"sequence":1763450000}},{"id":"custom-2","market":null}]}`)
	fake.routes["POST /api/market/source/refresh"] = answer(200, `{"status":"ok","results":[
		{"id":"official","ok":true,"sequence":1763460000,"commit":"0123456789abcdef"},
		{"id":"custom-1","ok":true,"sequence":1763460000,"commit":"89abcdef01234567"},
		{"id":"custom-2","ok":true,"sequence":1763460000,"commit":null}]}`)
	printed = captureStdout(t, func() { err = marketRefreshCmd.RunE(marketRefreshCmd, nil) })
	if err != nil || !strings.Contains(printed, "official: up to date (commit 0123456, 2025-11-18 10:00Z)") ||
		!strings.Contains(printed, "custom-1: updated to commit 89abcde, 2025-11-18 10:00Z") ||
		!strings.Contains(printed, "custom-2: updated to 2025-11-18 10:00Z") {
		t.Fatalf("refresh with earlier states: %v\n%s", err, printed)
	}
	fake.take()
	delete(fake.routes, "GET /api/market/source")

	fake.routes["POST /api/market/source/refresh"] = answer(200, `{"status":"ok","results":[{"id":"official","ok":true,"sequence":1763460000,"commit":null}]}`)
	printed = captureStdout(t, func() { err = marketRefreshCmd.RunE(marketRefreshCmd, []string{"official"}) })
	if err != nil || !strings.Contains(printed, "official: up to date (2025-11-18 10:00Z)") {
		t.Fatalf("refresh one: %v\n%s", err, printed)
	}
	checkSent(t, fake, "GET /api/market/source", `POST /api/market/source/refresh {"id":"official"}`)
}

func TestAppSourceAndBlockedUpdates(t *testing.T) {
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"PATCH /api/market/app/homebox/source": answer(200, `{"status":"ok","sourceId":"custom-2","sourceName":"apps.example.org"}`),
		"POST /api/apps/check-updates": answer(200, `{"apps":[
			{"appId":"memos","installedVersion":"1.0.0","catalogVersion":"1.0.0","updateAvailable":false},
			{"appId":"homebox","installedVersion":"0.27.1","updateAvailable":false,
			 "updateBlocked":{"code":"source-unavailable","message":"Market source \"custom-1\" is not configured\u001b[2J"}}]}`),
	})
	var err error
	printed := captureStdout(t, func() { err = appSourceCmd.RunE(appSourceCmd, []string{"homebox", "custom-2"}) })
	if err != nil || !strings.Contains(printed, "homebox now gets its updates from apps.example.org (custom-2)") {
		t.Fatalf("app source: %v\n%s", err, printed)
	}
	checkSent(t, fake, `PATCH /api/market/app/homebox/source {"sourceId":"custom-2"}`)

	printed = captureStdout(t, func() { err = appCheckUpdatesCmd.RunE(appCheckUpdatesCmd, nil) })
	if err != nil || strings.Contains(printed, "All apps are up to date") || strings.Contains(printed, "\x1b[2J") ||
		!strings.Contains(printed, "1 of the installed apps could not be checked") ||
		!strings.Contains(printed, `homebox: Market source "custom-1" is not configured`) ||
		!strings.Contains(printed, "youeye app source <app> <market id>") {
		t.Fatalf("check-updates with a blocked app: %v\n%s", err, printed)
	}

	fake.routes["PATCH /api/market/app/homebox/source"] = answer(403, `{"error":"Accept the market first","code":"source-not-accepted"}`)
	if err = appSourceCmd.RunE(appSourceCmd, []string{"homebox", "custom-2"}); err == nil || err.Error() != "Accept the market first" {
		t.Fatalf("a refused switch shows the Control Panel's reason: %v", err)
	}
}

const marketCatalogFixture = `{"apps":[
  {"id":"notes","name":"Notes","sourceId":"official","sourceName":"YouEye Market","version":"0.6.3","category":"productivity","description":"Write things down"},
  {"id":"razzia","name":"Razzia","sourceId":"custom-1","sourceName":"apps.example.org","version":"2.0.0","category":"media","description":"Media",
   "installBlocked":{"code":"requires-newer-youeye","message":"Razzia needs YouEye 0.7.0 or newer."},"needsYouEye":"0.7.0"},
  {"id":"jotter","name":"Jotter","sourceId":"andrew","sourceName":"Andrew","version":"1.0.0","category":"productivity","tagline":"Notes, but simpler","sourceNotAccepted":true}
],"categories":[],"curation":{},"bundles":[],"warnings":[]}`

func TestMarketSearch(t *testing.T) {
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"GET /api/market/catalog": answer(200, marketCatalogFixture),
	})
	var err error
	printed := captureStdout(t, func() { err = marketSearchCmd.RunE(marketSearchCmd, []string{"NOTES"}) })
	if err != nil {
		t.Fatal(err)
	}
	checkSent(t, fake, "GET /api/market/catalog")
	if !strings.Contains(printed, "YouEye Market") || !strings.Contains(printed, "market not accepted") || strings.Contains(printed, "Razzia") {
		t.Fatalf("search output:\n%s", printed)
	}

	var catalog map[string]interface{}
	_ = json.Unmarshal([]byte(marketCatalogFixture), &catalog)
	rows := marketSearchRows(catalog["apps"].([]interface{}), "media")
	if len(rows) != 1 || strings.Join(rows[0], "|") != "razzia|Razzia|apps.example.org|2.0.0|needs YouEye 0.7.0|Media" {
		t.Fatalf("rows: %q", rows)
	}
	if marketAppNote(map[string]interface{}{"installBlocked": map[string]interface{}{"code": "requires-newer-youeye"}}) != "needs a newer YouEye" {
		t.Error("a blocked app without a version")
	}
}

func TestMarketInfo(t *testing.T) {
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"GET /api/market/app/razzia?source=custom-1": answer(200, `{"app":{"id":"razzia","name":"Razzia","sourceId":"custom-1","sourceName":"apps.example.org",
			"sourceRepoUrl":"https://apps.example.org/market/","version":"2.0.0","category":"media","description":"Media",
			"installBlocked":{"code":"requires-newer-youeye","message":"Razzia needs YouEye 0.7.0 or newer."},"needsYouEye":"0.7.0",
			"setups":[{"name":"admin","for":"web"}],"supportsSSO":true},
			"variants":[],
			"installed":{"sourceId":"custom-1","sourceName":"apps.example.org","sourceAddress":"https://apps.example.org/market/","version":"1.9.0",
				"updateBlocked":{"code":"source-not-accepted","message":"The market apps.example.org is not accepted."}}}`),
		"GET /api/market/app/notes": answer(200, `{"app":{"id":"notes","name":"Notes","sourceId":"official","sourceName":"YouEye Market","version":"0.6.3"}}`),
	})
	t.Cleanup(func() { marketInfoSource = "" })
	marketInfoSource = "custom-1"
	var err error
	printed := captureStdout(t, func() { err = marketInfoCmd.RunE(marketInfoCmd, []string{"razzia"}) })
	if err != nil {
		t.Fatal(err)
	}
	checkSent(t, fake, "GET /api/market/app/razzia?source=custom-1")
	// `installed` as GET /api/market/app/<id> answers it (MarketAppInstalledSource): sourceAddress, updateBlocked.
	for _, part := range []string{"apps.example.org (custom-1)", "Razzia needs YouEye 0.7.0 or newer.", "YouEye 0.7.0", "Setup files",
		"version 1.9.0, from apps.example.org (custom-1), https://apps.example.org/market/", "The market apps.example.org is not accepted."} {
		if !strings.Contains(printed, part) {
			t.Errorf("info output lacks %q:\n%s", part, printed)
		}
	}
	// The official Market: the name differs from the id; an install without a recorded market or version.
	lines := marketInfoLines(decodeFixture(t, `{"app":{"id":"notes","name":"Notes","sourceId":"official","sourceName":"YouEye Market"},
		"installed":{"sourceId":null,"sourceName":null,"sourceAddress":null,"version":null,"updateBlocked":null}}`))
	if got := lines[len(lines)-1]; got != [2]string{"Installed", "yes"} {
		t.Errorf("installed without details: %q", got)
	}
	lines = marketInfoLines(decodeFixture(t, `{"app":{"id":"notes"},"installed":{"sourceId":"official","sourceName":"YouEye Market",
		"sourceAddress":"https://market.youeye.me/stable/","version":"0.6.3","updateBlocked":null}}`))
	if got := lines[len(lines)-1]; got != [2]string{"Installed", "version 0.6.3, from YouEye Market (official), https://market.youeye.me/stable/"} {
		t.Errorf("installed: %q", got)
	}
	// Without --source and with `installed: null` (not installed).
	fake.routes["GET /api/market/app/notes"] = answer(200, `{"app":{"id":"notes","name":"Notes","sourceId":"official","sourceName":"YouEye Market","version":"0.6.3"},"variants":[],"installed":null}`)
	marketInfoSource = ""
	printed = captureStdout(t, func() { err = marketInfoCmd.RunE(marketInfoCmd, []string{"notes"}) })
	if err != nil || strings.Contains(printed, "Installed") || !strings.Contains(printed, "0.6.3") {
		t.Fatalf("info notes: %v\n%s", err, printed)
	}
	checkSent(t, fake, "GET /api/market/app/notes")
	if got := marketInfoPath("a b", "x&y"); got != "/api/market/app/a%20b?source=x%26y" {
		t.Errorf("path %q", got)
	}
}

// A 409 requires-newer-youeye from an install is shown as its message; other errors stay as they are.
func TestAppInstallNeedsNewerYouEye(t *testing.T) {
	fake := useFakeControlPanel(t, map[string]func(string) (int, string){
		"POST /api/market/install": answer(409, `{"error":"Razzia needs a newer YouEye than this box runs.","code":"requires-newer-youeye","needsYouEye":"0.7.0"}`),
	})
	t.Cleanup(func() { appInstallSource = "" })
	appInstallSource = "custom-1"
	var err error
	captureStdout(t, func() { err = appInstallCmd.RunE(appInstallCmd, []string{"razzia"}) })
	if err == nil || err.Error() != "Razzia needs a newer YouEye than this box runs. (needs YouEye 0.7.0)" {
		t.Fatalf("install: %v", err)
	}
	checkSent(t, fake, `POST /api/market/install {"appId":"razzia","sourceId":"custom-1"}`)

	plain := &controlapi.HTTPError{StatusCode: 409, Body: []byte(`{"error":"busy","code":"operation_pending"}`)}
	if newerYouEyeRefusal(plain) != error(plain) || newerYouEyeRefusal(nil) != nil {
		t.Error("other answers must pass through")
	}
	if err := newerYouEyeRefusal(&controlapi.HTTPError{StatusCode: 409, Body: []byte(`{"error":"Needs YouEye 0.7.0.","code":"requires-newer-youeye","needsYouEye":"0.7.0"}`)}); err.Error() != "Needs YouEye 0.7.0." {
		t.Errorf("version repeated: %v", err)
	}
}

// --source naming no market (or one that is off) says so; the app route alone answers only "App not found".
func TestMarketInfoUnknownSource(t *testing.T) {
	useFakeControlPanel(t, map[string]func(string) (int, string){
		"GET /api/market/app/razzia?source=nope":     answer(404, `{"error":"App \"razzia\" not found"}`),
		"GET /api/market/app/razzia?source=andrew":   answer(404, `{"error":"App \"razzia\" not found"}`),
		"GET /api/market/app/razzia?source=custom-1": answer(404, `{"error":"App \"razzia\" not found"}`),
		"GET /api/market/app/razzia":                 answer(404, `{"error":"App \"razzia\" not found"}`),
		"GET /api/market/source":                     answer(200, marketSourcesFixture),
	})
	t.Cleanup(func() { marketInfoSource = "" })
	for source, want := range map[string]string{
		"nope":     `there is no market "nope" (see youeye market list)`,
		"andrew":   `market "andrew" is turned off, so its apps are not listed (see youeye market list)`,
		"custom-1": `App "razzia" not found`,
		"":         `App "razzia" not found`,
	} {
		marketInfoSource = source
		var err error
		captureStdout(t, func() { err = marketInfoCmd.RunE(marketInfoCmd, []string{"razzia"}) })
		if err == nil || err.Error() != want {
			t.Errorf("--source %q: %v, want %q", source, err, want)
		}
	}
}

// Text from a market or the Control Panel is printed without control characters or escape sequences.
func TestTerminalText(t *testing.T) {
	for _, c := range []struct{ in, line, lines string }{
		{"plain text, ünïcode ✓", "plain text, ünïcode ✓", "plain text, ünïcode ✓"},
		{"red \x1b[31mtext\x1b[0m", "red text", "red text"},
		{"\x1b[2J\x1b[1;1Hcleared", "cleared", "cleared"},
		{"title \x1b]0;owned\x07 bell", "title  bell", "title  bell"},
		{"link \x1b]8;;https://evil.example\x1b\\here\x1b]8;;\x1b\\", "link here", "link here"},
		{"dcs \x1bPq#0;2;0;0;0\x1b\\ end", "dcs  end", "dcs  end"},
		{"c1 csi \u009b31mred\u009b0m", "c1 csi red", "c1 csi red"},
		{"c1 osc \u009d0;x\u009c done", "c1 osc  done", "c1 osc  done"},
		{"reset\x1bc now", "reset now", "reset now"},
		{"charset \x1b(Bok", "charset ok", "charset ok"},
		{"bell\x07 back\x08space del\x7f nul\x00 cr\r", "bell backspace del nul cr", "bell backspace del nul cr"},
		{"c1 \u0085next \u0090", "c1 next ", "c1 next "},
		{"two\nlines\tand tab", "two lines and tab", "two\nlines\tand tab"},
		{"trailing escape \x1b", "trailing escape ", "trailing escape "},
		{"unterminated \x1b]0;rest", "unterminated ", "unterminated "},
		{"broken csi \x1b[12\nnext", "broken csi  next", "broken csi \nnext"},
		{"bad utf8 \xff\xfe", "bad utf8 \uFFFD", "bad utf8 \uFFFD"},
	} {
		if got := terminalText(c.in, false); got != c.line {
			t.Errorf("terminalText(%q, false) = %q, want %q", c.in, got, c.line)
		}
		if got := terminalText(c.in, true); got != c.lines {
			t.Errorf("terminalText(%q, true) = %q, want %q", c.in, got, c.lines)
		}
	}
}

// Every printing path of the market commands cleans what a market or the Control Panel sent.
func TestMarketOutputIsCleaned(t *testing.T) {
	const evil = `\u001b[2J\u001b]0;owned\u0007\u009b2J` // JSON escapes: ESC CSI, OSC title, BEL, C1 CSI
	sources := `{"sources":[{"id":"custom-1","name":"Na` + evil + `me","kind":"url","url":"https://a.example/","enabled":true,
		"address":"https://a.example/","accepted_at":"2026-11-18T08:30:00.000Z",
		"market":{"name":"Mar` + evil + `ket","publisher":"Pub` + evil + `","commit":"\u001b[2Jdeadbeef","sequence_date":"2025-11-18T07:13:20.000Z","apps":3},
		"refresh_error":"fail` + evil + `ed"}],
		"removed_sources":[{"id":"old","name":"Ol` + evil + `d","address":"https://git.example/x","removed_at":"2026-11-18T07:00:00.000Z"}]}`
	data := decodeFixture(t, sources)
	rows := marketListRows(data)
	if got := strings.Join(rows[0], "|"); got != `custom-1|Name|https://a.example/|"Market" by "Pub"||2025-11-18 07:13Z|3|yes|2026-11-18 08:30Z|failed (see below)` {
		t.Errorf("row: %q", got)
	}
	printed := captureStdout(t, func() { printMarketList(data) })
	if strings.ContainsAny(printed, "\x07\u009b") || strings.Contains(printed, "owned") || strings.Contains(printed, "[2J") {
		t.Errorf("market list prints control text:\n%q", printed)
	}
	if !strings.Contains(printed, "failed") || !strings.Contains(printed, "Old") {
		t.Errorf("market list lost text:\n%s", printed)
	}
	// A commit that is not hex is not shown; a hex one is.
	for commit, want := range map[string]string{"0123456789abcdef": "0123456", "abc1": "abc1", "abc": "", "main": "", "\x1b[31mdeadbeef": "", "deadbeef\n": ""} {
		if got := shortCommit(commit); got != want {
			t.Errorf("shortCommit(%q) = %q, want %q", commit, got, want)
		}
	}

	useFakeControlPanel(t, map[string]func(string) (int, string){
		"POST /api/market/source/refresh": answer(200, `{"results":[{"id":"official","ok":true,"commit":"\u001b[31m","sequence":1763460000},
			{"id":"custom-1","ok":false,"error":"HTTP`+evil+` 503"}]}`),
		"POST /api/market/source": answer(200, `{"source":{"id":"custom-2","address":"https://b.example/","refresh_error":"no`+evil+`pe"}}`),
		"GET /api/market/catalog": answer(200, `{"apps":[{"id":"x","name":"X`+evil+`","sourceName":"S`+evil+`","version":"1","tagline":"T`+evil+`"}]}`),
		"GET /api/market/app/x":   answer(200, `{"app":{"id":"x","name":"X`+evil+`","description":"D`+evil+`"},"installed":{"sourceName":"S`+evil+`","sourceAddress":"https://c.example/","version":"1"}}`),
		"GET /api/market/app/y":   answer(404, `{"error":"App \"y\"`+evil+` not found"}`),
	})
	var err error
	t.Cleanup(func() { marketAddTrusted = false })
	marketAddTrusted = true
	for name, run := range map[string]func(){
		"refresh": func() { err = marketRefreshCmd.RunE(marketRefreshCmd, nil) },
		"add":     func() { err = marketAddCmd.RunE(marketAddCmd, []string{"https://b.example/"}) },
		"search":  func() { err = marketSearchCmd.RunE(marketSearchCmd, []string{"x"}) },
		"info":    func() { err = marketInfoCmd.RunE(marketInfoCmd, []string{"x"}) },
		"refused": func() { err = marketInfoCmd.RunE(marketInfoCmd, []string{"y"}) },
	} {
		printed := captureStdout(t, run)
		if err != nil {
			printed += err.Error()
		}
		if strings.ContainsAny(printed, "\x07\u009b") || strings.Contains(printed, "owned") || strings.Contains(printed, "[2J") {
			t.Errorf("%s prints control text:\n%q", name, printed)
		}
		if name == "refused" && (err == nil || err.Error() != `App "y" not found`) {
			t.Errorf("refusal: %v", err)
		}
	}
	// An error without a message field is cleaned as a whole; a clean one is returned as it is.
	raw := &controlapi.HTTPError{StatusCode: 500, Body: []byte("oops \x1b[2J")}
	if got := cpPlainError(raw).Error(); got != "control panel returned 500: oops " {
		t.Errorf("raw error: %q", got)
	}
	if clean := errors.New("fine"); cleanServerError(clean) != clean || newerYouEyeRefusal(raw).Error() != "control panel returned 500: oops " {
		t.Error("cleanServerError")
	}
	refusal := &controlapi.HTTPError{StatusCode: 409, Body: []byte(`{"error":"Needs \u001b[31mnewer","code":"requires-newer-youeye","needsYouEye":"0.7.0\u0007"}`)}
	if got := newerYouEyeRefusal(refusal).Error(); got != "Needs newer (needs YouEye 0.7.0)" {
		t.Errorf("refusal: %q", got)
	}
}

func TestPrintableSecret(t *testing.T) {
	for _, exact := range []string{"admin", "p@ss wörd!\"'", ""} {
		if got := printableSecret(exact); got != exact {
			t.Fatalf("printableSecret(%q) = %q, want it unchanged", exact, got)
		}
	}
	hostile := "admin\x1b[2K\rroot"
	got := printableSecret(hostile)
	if got == hostile || strings.ContainsAny(got, "\x1b\r") || got != strconv.Quote(hostile) {
		t.Fatalf("printableSecret(%q) = %q, want it quoted with the control characters visible", hostile, got)
	}
}
