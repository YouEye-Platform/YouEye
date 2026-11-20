package cmd

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
)

// followFake is a Control Panel whose update or install stream breaks off (or ends) after its first event, then
// answers status reads from a script: the first read before the request, the rest while the CLI follows.
type followFake struct {
	mu       sync.Mutex
	statuses []interface{} // answers to /api/market/update/status or /api/market/install-status, in order
	reads    int
	posts    int
	stream   string            // "drop" (connection broken), "end" (closed without an outcome) or a full body
	streams  map[string]string // per app (the path's app name), instead of stream
	refuse   int               // answer the POST with this status instead of a stream
	updates  []interface{}     // the apps /api/market/updates lists
}

func (f *followFake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-CLI-Token") != "token" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/market/updates":
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"apps": f.updates})
	case r.Method == http.MethodGet && (strings.HasPrefix(r.URL.Path, "/api/market/update/status") ||
		strings.HasPrefix(r.URL.Path, "/api/market/install-status")):
		f.mu.Lock()
		answer := f.statuses[min(f.reads, len(f.statuses)-1)]
		f.reads++
		f.mu.Unlock()
		if code, ok := answer.(int); ok {
			w.WriteHeader(code)
			return
		}
		_ = json.NewEncoder(w).Encode(answer)
	case r.Method == http.MethodPost:
		f.mu.Lock()
		f.posts++
		f.mu.Unlock()
		if f.refuse != 0 {
			w.WriteHeader(f.refuse)
			_, _ = w.Write([]byte(`{"error":"An update is pending. Check its status or retry recovery.","code":"operation_pending"}`))
			return
		}
		stream := f.stream
		if app := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/apps/"), "/update"); f.streams[app] != "" {
			stream = f.streams[app]
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		switch stream {
		case "drop", "end", "named-drop":
			named := ""
			if stream == "named-drop" {
				named = `,"operationId":"mine"`
			}
			_, _ = w.Write([]byte("event: update\ndata: {\"stage\":\"rebuilding\",\"message\":\"Updating application...\"" + named + "}\n\n"))
			w.(http.Flusher).Flush()
			if stream == "drop" || stream == "named-drop" {
				// Closes the connection without the chunked stream's end: the client reads io.ErrUnexpectedEOF.
				panic(http.ErrAbortHandler)
			}
		default:
			_, _ = w.Write([]byte(stream))
		}
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func useFollowFake(t *testing.T, fake *followFake) {
	t.Helper()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	old, oldPoll, oldLimit, oldStart, oldSleep := controlClient, followPollInterval, followLimit, followStartLimit, followSleep
	controlClient = controlapi.NewClientAt(server.URL, "token")
	followPollInterval, followLimit, followStartLimit = time.Millisecond, 2*time.Second, 200*time.Millisecond
	followSleep = time.Sleep
	t.Cleanup(func() {
		controlClient, followPollInterval, followLimit, followStartLimit, followSleep = old, oldPoll, oldLimit, oldStart, oldSleep
	})
}

type op = map[string]interface{}

// operation is an update operation record in a status answer.
func operation(id string, pending, committed, rolledBack, recovery bool) op {
	return op{"id": id, "pending": pending, "committed": committed, "rolledBack": rolledBack, "recoveryRequired": recovery}
}

// result is an update's returned result in a status answer.
func result(operationID string, success bool, message, at string) op {
	var id interface{}
	if operationID != "" {
		id = operationID
	}
	return op{"operationId": id, "success": success, "message": message, "at": at, "errorCode": nil}
}

// status is a Market app's update status: its operation record, its last returned result, and whether an update is
// still on its way to one.
func status(operation op, result op, running bool) map[string]interface{} {
	answer := map[string]interface{}{"operation": nil, "result": nil, "running": running, "market": true}
	if operation != nil {
		answer["operation"] = operation
	}
	if result != nil {
		answer["result"] = result
	}
	return answer
}

// before is the status before the update: an older, finished update and its result.
var before = status(operation("old", false, true, false, false), result("old", true, "Update complete", "t0"), false)

func exitCode(err error) int {
	var exit *ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		return -1
	}
	return 0
}

func TestAppUpdateFollowsAfterTheStreamDrops(t *testing.T) {
	committed := operation("new", false, true, false, false)
	cases := []struct {
		name   string
		stream string
		after  []interface{}
		code   int
		says   string
	}{
		{"committed", "drop", []interface{}{status(operation("new", true, false, false, false), nil, true), 503,
			status(committed, nil, true), status(committed, result("new", true, "Update complete", "t1"), false)}, 0,
			"Update complete"},
		{"ended without an outcome", "end", []interface{}{status(committed, result("new", true, "Update complete", "t1"),
			false)}, 0, "Update complete"},
		{"rolled back", "drop", []interface{}{status(operation("new", true, false, false, false), nil, true),
			status(operation("new", false, false, true, false), result("new", false, "The update failed and was rolled back.",
				"t1"), false)}, 1, "rolled back"},
		{"recovery required", "drop", []interface{}{status(operation("new", false, false, false, true),
			result("new", false, "Retry recovery (youeye app recover <app>)", "t1"), false)}, 1, "youeye app recover immich"},
		// Committed and cleaned up, then a step after the update failed: the record looks finished, the result is not
		// a success. The follow waits for the result while the update still runs.
		{"committed, then failed", "drop", []interface{}{status(committed, nil, true), status(committed, nil, true),
			status(committed, result("new", false, "The new version is installed and the app is open, but a step after "+
				"the update failed", "t1"), false)}, 1, "a step after the update failed"},
		// Ended without an operation of its own (already up to date): its newer result is the outcome.
		{"already up to date", "drop", []interface{}{status(operation("old", false, true, false, false),
			result("", true, "Already up to date: nothing was changed.", "t1"), false)}, 0, "Already up to date"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &followFake{stream: tc.stream, statuses: append([]interface{}{before}, tc.after...)}
			useFollowFake(t, fake)
			var err error
			printed := captureStdout(t, func() { err = runAppUpdate("immich", nil) })
			if got := exitCode(err); got != tc.code {
				t.Fatalf("exit %d (%v), want %d", got, err, tc.code)
			}
			if fake.reads < 2 {
				t.Fatalf("the update was not followed: %d status reads", fake.reads)
			}
			if fake.reads != len(tc.after)+1 {
				t.Fatalf("the follow decided after %d status reads, want %d", fake.reads, len(tc.after)+1)
			}
			if !strings.Contains(printed, tc.says) || !strings.Contains(printed, lostProgressNotice) {
				t.Fatalf("printed %q, want %q", printed, tc.says)
			}
		})
	}
}

// An update that returned with its operation still pending (committed with reopening or cleanup unfinished, or rolled
// back with cleanup unfinished) is not one still running: the follow says what is unfinished and how to recover, and
// ends at once.
func TestAppUpdateFollowEndsAtAPendingResult(t *testing.T) {
	fake := &followFake{stream: "drop", statuses: []interface{}{before,
		status(operation("new", true, true, false, false), result("new", false,
			"The new version is installed and the app is open; removing the update's recovery points did not finish. "+
				"Retry recovery (youeye app recover <app>); the cause is in the Control Panel journal.", "t1"), false)}}
	useFollowFake(t, fake)
	var err error
	printed := captureStdout(t, func() { err = runAppUpdate("immich", nil) })
	if exitCode(err) != 1 || fake.reads != 2 || !strings.Contains(printed, "youeye app recover immich") {
		t.Fatalf("pending result: %v after %d reads, printed %q", err, fake.reads, printed)
	}
}

// A Control Panel that restarted has no result: once the update no longer runs, its operation record is the outcome,
// and the CLI says the final result was not recorded.
func TestAppUpdateFollowWithoutTheResult(t *testing.T) {
	cases := []struct {
		name      string
		operation op
		code      int
	}{
		{"committed", operation("new", false, true, false, false), 0},
		{"rolled back", operation("new", false, false, true, false), 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &followFake{stream: "drop", statuses: []interface{}{before, 503,
				status(operation("new", true, false, false, false), nil, false), status(tc.operation, nil, false)}}
			useFollowFake(t, fake)
			var err error
			printed := captureStdout(t, func() { err = runAppUpdate("immich", nil) })
			if got := exitCode(err); got != tc.code || !strings.Contains(printed, "did not record the update's final result") {
				t.Fatalf("exit %d (%v), want %d; printed %q", got, err, tc.code, printed)
			}
		})
	}
}

// An earlier, finished update is not this update's outcome: once no update runs and none was recorded, the follow
// says how to check.
func TestAppUpdateFollowIgnoresTheUpdateBeforeIt(t *testing.T) {
	fake := &followFake{stream: "drop", statuses: []interface{}{before, status(operation("old", false, true, false, false),
		result("old", true, "Update complete", "t0"), true), before}}
	useFollowFake(t, fake)
	err := runAppUpdate("immich", nil)
	if exitCode(err) == 0 || !strings.Contains(err.Error(), "youeye app info immich") || fake.reads != 3 {
		t.Fatalf("an old update was taken as the outcome: %v after %d reads", err, fake.reads)
	}
}

// Without a status read before the request, an operation counts as this update's once it was seen pending, and a
// result is this update's once no update runs.
func TestAppUpdateFollowWithoutTheStatusBeforeIt(t *testing.T) {
	fake := &followFake{stream: "drop", statuses: []interface{}{503, status(operation("new", true, false, false, false), nil,
		true), status(operation("new", false, true, false, false), result("new", true, "Update complete", "t1"), false)}}
	useFollowFake(t, fake)
	if err := runAppUpdate("immich", nil); err != nil {
		t.Fatalf("followed update: %v", err)
	}
}

func TestAppUpdateFollowIsBounded(t *testing.T) {
	fake := &followFake{stream: "drop", statuses: []interface{}{before,
		status(operation("new", true, false, false, false), nil, true)}}
	useFollowFake(t, fake)
	followLimit = 50 * time.Millisecond
	err := runAppUpdate("immich", nil)
	if exitCode(err) == 0 || !strings.Contains(err.Error(), "still running") ||
		!strings.Contains(err.Error(), "youeye app recover immich") {
		t.Fatalf("unbounded follow: %v", err)
	}
}

// A built-in app (Pointer, Caddy, ...) has its own updater, which records no Market update: its lost stream is
// reported at once, whether the status before the request or the first one after it says so.
func TestAppUpdateOfABuiltInAppIsNotFollowed(t *testing.T) {
	builtIn := map[string]interface{}{"operation": nil, "result": nil, "running": false, "market": false}
	for name, statuses := range map[string][]interface{}{
		"known before":        {builtIn},
		"known when lost":     {503, builtIn},
		"older Control Panel": {map[string]interface{}{"operation": nil}},
	} {
		t.Run(name, func(t *testing.T) {
			fake := &followFake{stream: "drop", statuses: statuses}
			useFollowFake(t, fake)
			var err error
			printed := captureStdout(t, func() { err = runAppUpdate("caddy", nil) })
			if err == nil || !strings.Contains(err.Error(), "lost the Control Panel's progress stream") ||
				!strings.Contains(err.Error(), "youeye app info caddy") || fake.reads != len(statuses) {
				t.Fatalf("built-in: %v after %d reads", err, fake.reads)
			}
			if strings.Contains(printed, lostProgressNotice) && name == "known before" {
				t.Fatalf("a built-in update was announced as followed: %q", printed)
			}
		})
	}
}

// 'youeye app update --all' updates every app and exits 1 when any of them did not succeed.
func TestAppUpdateAllExitsOneWhenAnAppFails(t *testing.T) {
	completed := "event: update\ndata: {\"stage\":\"completed\",\"message\":\"Update complete\"}\n\n"
	failed := "event: update\ndata: {\"stage\":\"failed\",\"message\":\"Update failed.\"}\n\n"
	apps := []interface{}{
		map[string]interface{}{"appId": "immich", "updateAvailable": true},
		map[string]interface{}{"appId": "wiki", "updateAvailable": true},
		map[string]interface{}{"appId": "notes", "updateAvailable": false},
	}
	for name, tc := range map[string]struct {
		streams map[string]string
		code    int
	}{
		"one fails":   {map[string]string{"immich": failed, "wiki": completed}, 1},
		"all succeed": {map[string]string{"immich": completed, "wiki": completed}, 0},
	} {
		t.Run(name, func(t *testing.T) {
			fake := &followFake{streams: tc.streams, updates: apps, statuses: []interface{}{before}}
			useFollowFake(t, fake)
			var err error
			printed := captureStdout(t, func() { err = updateAllApps() })
			if got := exitCode(err); got != tc.code || fake.posts != 2 {
				t.Fatalf("exit %d (%v) after %d updates, want %d; printed %q", got, err, fake.posts, tc.code, printed)
			}
		})
	}
}

func TestAppUpdateStreamOutcomes(t *testing.T) {
	cases := []struct {
		name, stream string
		code         int
	}{
		{"completed", "event: update\ndata: {\"stage\":\"completed\",\"message\":\"Update complete\"}\n\n", 0},
		{"failed", "event: update\ndata: {\"stage\":\"failed\",\"message\":\"Update failed.\"}\n\n", -1},
		// The update returned with its operation unfinished: not a success.
		{"pending", "event: update\ndata: {\"stage\":\"pending\",\"message\":\"Update pending.\"}\n\n", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &followFake{stream: tc.stream, statuses: []interface{}{before}}
			useFollowFake(t, fake)
			err := runAppUpdate("immich", nil)
			if got := exitCode(err); got != tc.code {
				t.Fatalf("exit %d (%v), want %d", got, err, tc.code)
			}
			if fake.reads != 1 {
				t.Fatalf("a streamed outcome was followed: %d status reads", fake.reads)
			}
		})
	}
}

// A refusal is an answer, not a lost stream: nothing is followed.
func TestAppUpdateRefusalIsNotFollowed(t *testing.T) {
	fake := &followFake{refuse: http.StatusConflict, statuses: []interface{}{status(operation("old", true, false, false,
		false), nil, false)}}
	useFollowFake(t, fake)
	err := runAppUpdate("immich", nil)
	if err == nil || !strings.Contains(err.Error(), "409") || fake.reads != 1 {
		t.Fatalf("refusal: %v after %d status reads", err, fake.reads)
	}
}

func TestAppInstallFollowsAfterTheStreamDrops(t *testing.T) {
	cases := []struct {
		name     string
		statuses []interface{}
		code     int
	}{
		{"installed", []interface{}{map[string]interface{}{"done": false}, 503,
			map[string]interface{}{"done": true, "appName": "Immich"}}, 0},
		{"failed", []interface{}{map[string]interface{}{"done": true, "error": "Downloading the app image failed"}}, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &followFake{stream: "drop", statuses: tc.statuses}
			useFollowFake(t, fake)
			var err error
			printed := captureStdout(t, func() { err = runAppInstall("immich", map[string]interface{}{"appId": "immich"}) })
			if got := exitCode(err); got != tc.code {
				t.Fatalf("exit %d (%v), want %d", got, err, tc.code)
			}
			// The stream's words, which tests/market-sso/app-round.sh looks for.
			if installed := strings.Contains(printed, "Immich installed successfully!"); installed != (tc.code == 0) {
				t.Fatalf("printed %q", printed)
			}
		})
	}
}

func TestAppInstallStreamEndIsNotFollowed(t *testing.T) {
	fake := &followFake{stream: "data: {\"step\":3,\"totalSteps\":3,\"status\":\"success\",\"message\":\"Started\"}\n\n",
		statuses: []interface{}{404}}
	useFollowFake(t, fake)
	if err := runAppInstall("immich", map[string]interface{}{"appId": "immich"}); err != nil || fake.reads != 0 {
		t.Fatalf("install: %v after %d status reads", err, fake.reads)
	}
}

// A second update of the app that returned within one poll of this one replaces the latest result; this update's own
// result is still among the kept ones, and it decides: a commit whose later step failed exits 1, not 0.
func TestAppUpdateFollowFindsItsResultBehindALaterOne(t *testing.T) {
	failed := result("new", false, "The new version is installed and the app is open, but a step after the update "+
		"failed; the cause is in the Control Panel journal.", "t1")
	later := result("newer", true, "Update complete", "t2")
	answer := status(operation("newer", false, true, false, false), later, false)
	answer["results"] = []interface{}{failed, later}
	fake := &followFake{stream: "drop", statuses: []interface{}{before,
		status(operation("new", true, false, false, false), nil, true), answer}}
	useFollowFake(t, fake)
	var err error
	printed := captureStdout(t, func() { err = runAppUpdate("immich", nil) })
	shown := printed
	if err != nil {
		shown += err.Error()
	}
	if exitCode(err) != 1 || !strings.Contains(shown, "a step after the update failed") {
		t.Fatalf("later result hid this one: %v, printed %q", err, printed)
	}
}

// A Control Panel that never answered the status read is not reported as an update "still running".
func TestAppUpdateFollowSaysWhenTheStatusWasNeverRead(t *testing.T) {
	fake := &followFake{stream: "drop", statuses: []interface{}{before, 503}}
	useFollowFake(t, fake)
	followLimit = 50 * time.Millisecond
	err := runAppUpdate("immich", nil)
	if exitCode(err) == 0 || !strings.Contains(err.Error(), "could not read the update status") ||
		strings.Contains(err.Error(), "still running") {
		t.Fatalf("unreadable status: %v", err)
	}
}

// The stream names this update's operation: after a drop, its result is reported even when another client's update of
// the app created the first operation the follower sees.
func TestAppUpdateFollowUsesTheStreamedOperation(t *testing.T) {
	theirs := status(operation("theirs", true, false, false, false), nil, true)
	answer := status(operation("theirs", false, true, false, false), result("theirs", true, "Update complete", "t2"), false)
	answer["results"] = []interface{}{result("mine", false, "The update failed and was rolled back: the app runs its "+
		"previous version. The cause is in the Control Panel journal.", "t1"), result("theirs", true, "Update complete", "t2")}
	fake := &followFake{stream: "named-drop", statuses: []interface{}{before, theirs, answer}}
	useFollowFake(t, fake)
	var err error
	printed := captureStdout(t, func() { err = runAppUpdate("immich", nil) })
	if exitCode(err) != 1 || !strings.Contains(printed+errText(err), "rolled back") {
		t.Fatalf("followed another update: %v, printed %q", err, printed)
	}
}

// This update's result was lost with a restart and the app was updated again since: say so, without waiting 30 min.
func TestAppUpdateFollowReportsAReplacedLostResult(t *testing.T) {
	fake := &followFake{stream: "named-drop", statuses: []interface{}{before,
		status(operation("theirs", false, true, false, false), nil, false)}}
	useFollowFake(t, fake)
	err := runAppUpdate("immich", nil)
	if exitCode(err) == 0 || !strings.Contains(errText(err), "updated since") {
		t.Fatalf("replaced lost result: %v", err)
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
