package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type restartRecorder struct {
	mu       sync.Mutex
	restarts int
	kills    int
	starts   int
	// admittedDuring: whether ordinary work could start while the restart ran.
	admittedDuring []bool
}

func (r *restartRecorder) counts() (int, int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.restarts, r.kills, r.starts
}

func testRestarter(t *testing.T, barrier systemupdate.CoreLifecycleBarrier, recorder *restartRecorder, restart func(ctx context.Context) error) *controlRestarter {
	t.Helper()
	if restart == nil {
		restart = func(context.Context) error { return nil }
	}
	return &controlRestarter{
		tryIdle: func() (func(), bool, error) { return holdPlatformIdle(barrier, "") },
		restart: func(ctx context.Context) error {
			release, err := barrier.AdmitOrdinary()
			if err == nil {
				release()
			}
			recorder.mu.Lock()
			recorder.restarts++
			recorder.admittedDuring = append(recorder.admittedDuring, err == nil)
			recorder.mu.Unlock()
			return restart(ctx)
		},
		kill: func() error {
			recorder.mu.Lock()
			recorder.kills++
			recorder.mu.Unlock()
			return nil
		},
		start: func(context.Context) error {
			recorder.mu.Lock()
			recorder.starts++
			recorder.mu.Unlock()
			return nil
		},
		poll:      10 * time.Millisecond,
		stopGrace: time.Second,
		logf:      func(string, ...interface{}) {},
	}
}

// lifecycleRoot is a private directory, as the lifecycle protocol requires.
func lifecycleRoot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "app-updates")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	return root
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// An app install holds the lifecycle lock (shared) from start to end. A restart requested meanwhile (setup's last
// step) waits for it instead of stopping the Control Panel under it, and nothing new starts while it restarts.
func TestControlRestartWaitsForRunningLifecycleWork(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	install, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, nil)

	restarter.schedule(0)
	restarter.schedule(0) // a second request while the first waits shares it
	time.Sleep(200 * time.Millisecond)
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("the Control Panel was restarted while an install held the lifecycle")
	}

	install()
	waitFor(t, "the restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	time.Sleep(100 * time.Millisecond)
	restarts, kills, _ := recorder.counts()
	if restarts != 1 || kills != 0 {
		t.Fatalf("restarts %d kills %d, want one restart and no kill", restarts, kills)
	}
	if recorder.admittedDuring[0] {
		t.Fatal("ordinary work was admitted while the Control Panel restarted")
	}
	release, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatalf("the restart kept the lifecycle locked: %v", err)
	}
	release()

	// After a restart has run, a new request restarts again (its change may be newer than that restart).
	restarter.schedule(0)
	waitFor(t, "the second restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 2 })
}

// A System update, recovery or independent copy owns the platform through its reservation, without holding the
// locks: the Control Panel is theirs to stop and start, so the restart waits until the reservation is gone.
func TestControlRestartWaitsForSystemReservation(t *testing.T) {
	root := lifecycleRoot(t)
	barrier := systemupdate.CoreLifecycleBarrier{Root: root}
	reservation := filepath.Join(root, "core-reservation.json")
	raw, _ := json.Marshal(map[string]string{"schema": "youeye.core-lifecycle.v1", "request_id": "core-update-1",
		"manifest_sha256": "0000000000000000000000000000000000000000000000000000000000000001"})
	if err := os.WriteFile(reservation, raw, 0600); err != nil {
		t.Fatal(err)
	}
	recorder := &restartRecorder{}
	testRestarter(t, barrier, recorder, nil).schedule(0)
	time.Sleep(200 * time.Millisecond)
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("the Control Panel was restarted during a System update")
	}
	if err := os.Remove(reservation); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
}

// With the locks held only open requests can keep the stop waiting (a user operation queued at the gate gives up
// within 30 s); past the grace they are ended and the service started, instead of systemd's 90 s.
func TestControlRestartEndsAStopThatOutlastsTheGrace(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	restarter.stopGrace = 50 * time.Millisecond
	restarter.schedule(0)
	waitFor(t, "kill and start", func() bool { _, kills, starts := recorder.counts(); return kills == 1 && starts == 1 })
}

// The route answers at once; the restart happens later.
func TestControlRestartRouteAnswersAtOnce(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	install, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	recorder := &restartRecorder{}
	s := &Server{controlRestart: testRestarter(t, barrier, recorder, nil)}
	w := httptest.NewRecorder()
	s.handleControlRestart(w, httptest.NewRequest(http.MethodPost, "/api/control/restart?delay=1", nil))
	var body map[string]string
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &body) != nil || body["status"] != "scheduled" {
		t.Fatalf("answer %d %s", w.Code, w.Body.String())
	}
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("restarted before the delay")
	}
	install()
	waitFor(t, "the restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
}

// A restart that was waiting when Spine restarted (a Spine update) is made by the next `api serve`.
func TestControlRestartSurvivesASpineRestart(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	pending := filepath.Join(t.TempDir(), "control", ".restart-pending")
	install, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	first := testRestarter(t, barrier, &restartRecorder{}, nil)
	first.pendingPath = pending
	first.schedule(time.Hour) // this process "ends" before it restarts
	if _, err := os.Stat(pending); err != nil {
		t.Fatalf("a waiting restart is not recorded: %v", err)
	}
	install()

	recorder := &restartRecorder{}
	next := testRestarter(t, barrier, recorder, nil)
	next.pendingPath = pending
	next.resume()
	waitFor(t, "the resumed restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	if _, err := os.Stat(pending); !os.IsNotExist(err) {
		t.Fatalf("the record outlived the restart: %v", err)
	}
}

// An independent copy changes the destination's address and then waits for the restart that loads it: its
// reservation must not hold the restart back.
func TestControlRestartRunsDuringAnIndependentCopy(t *testing.T) {
	root := lifecycleRoot(t)
	if err := os.WriteFile(filepath.Join(root, "copy-reservation.json"), []byte(`{"schema":"youeye.copy-lifecycle.v1"}`), 0600); err != nil {
		t.Fatal(err)
	}
	recorder := &restartRecorder{}
	testRestarter(t, systemupdate.CoreLifecycleBarrier{Root: root}, recorder, nil).schedule(0)
	waitFor(t, "the restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
}

// holdBackupOperation takes the backup operation lock as the Control Panel does for a whole set (AppUpdateExecutorLock:
// a private directory, an empty 0600 file, an exclusive flock kept by the open descriptor).
func holdBackupOperation(t *testing.T, path string) (release func()) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	return func() { _ = file.Close() }
}

// A platform backup takes the lifecycle lock for each archive and lets go of it between archives, so a System update
// can run between two archives; it holds the backup operation lock for the whole set. A restart asked for between
// two archives waits for the whole set (it used to restart there and leave the set "creating"), while the lifecycle
// stays free for a System update.
func TestControlRestartWaitsForAWholePlatformBackup(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	backupLock := filepath.Join(t.TempDir(), "backups", ".operation.flock")
	set := holdBackupOperation(t, backupLock)
	archive, err := barrier.AdmitOrdinary() // the core archive
	if err != nil {
		t.Fatal(err)
	}
	archive()

	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, nil)
	restarter.tryIdle = func() (func(), bool, error) { return holdPlatformIdle(barrier, backupLock) }
	restarter.schedule(0)
	time.Sleep(200 * time.Millisecond)
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("the Control Panel was restarted between two archives of a platform backup")
	}
	// What a System update takes is free between archives: it neither waits for the whole set nor fails during it.
	// (The waiting restart tries the locks every poll and holds them for an instant when it does: look more than once.)
	waitFor(t, "the lifecycle to be free between archives", func() bool {
		update, busy, err := tryExclusiveLock(filepath.Join(barrier.Root, "core-lifecycle.flock"))
		if err != nil {
			t.Fatal(err)
		}
		if !busy {
			update()
		}
		return !busy
	})
	waitFor(t, "the next archive to be admitted while the restart waits", func() bool {
		archive, err := barrier.AdmitOrdinary() // the next archive
		if err == nil {
			archive()
		}
		return err == nil
	})
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("restarted before the set ended")
	}

	set()
	waitFor(t, "the restart after the set", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	// The lock is free again after the restart.
	again := holdBackupOperation(t, backupLock)
	again()
}

// While the Control Panel restarts, a backup or restore cannot start in the old process: its lock is busy.
func TestControlRestartHoldsTheBackupOperationLock(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	backupLock := filepath.Join(t.TempDir(), "backups", ".operation.flock")
	recorder := &restartRecorder{}
	var heldDuring []bool
	restarter := testRestarter(t, barrier, recorder, func(context.Context) error {
		release, busy, err := tryExclusiveLock(backupLock)
		if err == nil && !busy {
			release()
		}
		recorder.mu.Lock()
		heldDuring = append(heldDuring, busy)
		recorder.mu.Unlock()
		return nil
	})
	restarter.tryIdle = func() (func(), bool, error) { return holdPlatformIdle(barrier, backupLock) }
	restarter.schedule(0)
	waitFor(t, "the restart", func() bool { recorder.mu.Lock(); defer recorder.mu.Unlock(); return len(heldDuring) == 1 })
	if !heldDuring[0] {
		t.Fatalf("the backup operation lock was free during the restart: %v", heldDuring)
	}
}

// Locks say that something holds them, not that it moves. Work that never ends (a hung install, a lock nobody
// lets go of) kept the restart waiting for ever; now it is made after maxWait, without the locks.
func TestControlRestartDoesNotWaitForEver(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	hung, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	defer hung()
	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, nil)
	restarter.pendingPath = filepath.Join(t.TempDir(), "control", ".restart-pending")
	var logged []string
	var mu sync.Mutex
	restarter.logf = func(format string, args ...interface{}) {
		mu.Lock()
		logged = append(logged, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	restarter.maxWait = 150 * time.Millisecond
	restarter.schedule(0)
	time.Sleep(60 * time.Millisecond)
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("restarted while the work ran and the wait had not ended")
	}
	waitFor(t, "the restart after the longest wait", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	waitFor(t, "the record to go", func() bool { _, err := os.Stat(restarter.pendingPath); return os.IsNotExist(err) })
	mu.Lock()
	defer mu.Unlock()
	if len(logged) != 1 || !strings.Contains(logged[0], "WITHOUT waiting any longer") {
		t.Fatalf("the forced restart was not logged: %v", logged)
	}
}

// Never under a System update or recovery: it restarts the Control Panel itself and ends by itself.
func TestControlRestartNeverCutsASystemUpdateOff(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	hung, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, nil)
	restarter.maxWait = 20 * time.Millisecond
	owns := true
	var mu sync.Mutex
	restarter.systemOwns = func() bool { mu.Lock(); defer mu.Unlock(); return owns }
	restarter.schedule(0)
	time.Sleep(150 * time.Millisecond)
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("restarted under a System update")
	}
	// The update ended; what remains is ordinary work that has outlasted the wait.
	mu.Lock()
	owns = false
	mu.Unlock()
	waitFor(t, "the restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	hung()
}

// The record of a waiting restart is removed only when the service has been started again, and a restart that
// fails is tried again. Before 0.6.15 the record went first and a failure was only logged: the restart was lost.
func TestControlRestartIsNotLostWhenItFails(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	recorder := &restartRecorder{}
	pending := filepath.Join(t.TempDir(), "control", ".restart-pending")
	var mu sync.Mutex
	failures, recordSeen := 2, []bool{}
	restarter := testRestarter(t, barrier, recorder, func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		_, err := os.Stat(pending)
		recordSeen = append(recordSeen, err == nil)
		if failures > 0 {
			failures--
			return fmt.Errorf("Error: Instance is not running")
		}
		return nil
	})
	restarter.pendingPath = pending
	restarter.retryWait = 5 * time.Millisecond
	restarter.schedule(0)
	waitFor(t, "the third attempt", func() bool { restarts, _, _ := recorder.counts(); return restarts == 3 })
	waitFor(t, "the record to go", func() bool { _, err := os.Stat(pending); return os.IsNotExist(err) })
	mu.Lock()
	if fmt.Sprint(recordSeen) != "[true true true]" {
		t.Fatalf("the record was gone during an attempt: %v", recordSeen)
	}
	mu.Unlock()
	if _, kills, _ := recorder.counts(); kills != 0 {
		t.Fatal("a failed restart was treated as a stop that did not end")
	}

	// It gives up after restartAttempts and leaves the record for the next `api serve`.
	recorder = &restartRecorder{}
	restarter = testRestarter(t, barrier, recorder, func(context.Context) error { return fmt.Errorf("Error: Instance not found") })
	restarter.pendingPath = pending
	restarter.retryWait, restarter.restartAttempts = time.Millisecond, 3
	restarter.schedule(0)
	waitFor(t, "the last attempt", func() bool { restarts, _, _ := recorder.counts(); return restarts == 3 })
	time.Sleep(50 * time.Millisecond)
	if restarts, _, _ := recorder.counts(); restarts != 3 {
		t.Fatalf("%d attempts", restarts)
	}
	if _, err := os.Stat(pending); err != nil {
		t.Fatalf("the record of a restart that was not made is gone: %v", err)
	}
	// A request after that starts a new one.
	restarter.restart = func(context.Context) error { return nil }
	restarter.schedule(0)
	waitFor(t, "the record to go", func() bool { _, err := os.Stat(pending); return os.IsNotExist(err) })
}

// The kill path reports a service that could not be started, so it is tried again too.
func TestControlRestartRetriesAStartThatFailsAfterTheKill(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	recorder := &restartRecorder{}
	var mu sync.Mutex
	hang := true
	restarter := testRestarter(t, barrier, recorder, func(ctx context.Context) error {
		mu.Lock()
		wait := hang
		hang = false
		mu.Unlock()
		if wait {
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	})
	restarter.stopGrace, restarter.retryWait = 30*time.Millisecond, time.Millisecond
	restarter.start = func(context.Context) error { return fmt.Errorf("Error: Instance is busy") }
	restarter.schedule(0)
	waitFor(t, "the second restart", func() bool { restarts, kills, _ := recorder.counts(); return restarts == 2 && kills == 1 })
}

// A retry waited for its own pause, not for work: only the first try may say "after … of app or platform work"
// (koshka 360: "restarting the Control Panel after 30s of app or platform work" on an idle box whose Control Panel
// container was stopped).
func TestControlRestartRetryDoesNotBlameWork(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	recorder := &restartRecorder{}
	failures := 2
	var mu sync.Mutex
	restarter := testRestarter(t, barrier, recorder, func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		if failures > 0 {
			failures--
			return fmt.Errorf("Error: Instance is not running")
		}
		return nil
	})
	var logged []string
	restarter.logf = func(format string, args ...interface{}) {
		mu.Lock()
		logged = append(logged, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	// Long enough that the retries start more than 2 s after the request.
	restarter.retryWait, restarter.retryMax = 1100*time.Millisecond, 1100*time.Millisecond
	restarter.schedule(0)
	waitFor(t, "the third attempt", func() bool { restarts, _, _ := recorder.counts(); return restarts == 3 })
	mu.Lock()
	defer mu.Unlock()
	for _, line := range logged {
		if strings.Contains(line, "of app or platform work") {
			t.Fatalf("a retry was logged as a wait for work: %v", logged)
		}
	}
	if len(logged) != 2 {
		t.Fatalf("want the two failures logged, got %v", logged)
	}
}

// The longest wait never cuts a platform backup or restore off: both can take longer than it (a restore of a large
// box, a backup to a slow drive), and until 0.6.15 the forced restart ended them half-way. When the wait ends under
// one it starts again, so other work that is still running when the backup has ended gets its full time, and work
// that never ends is still restarted over.
func TestControlRestartNeverCutsABackupOrRestoreOff(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	backupLock := filepath.Join(t.TempDir(), "backups", ".operation.flock")
	restore := holdBackupOperation(t, backupLock)
	archive, err := barrier.AdmitOrdinary() // the restore holds the lifecycle too
	if err != nil {
		t.Fatal(err)
	}
	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, nil)
	restarter.tryIdle = func() (func(), bool, error) { return holdPlatformIdle(barrier, backupLock) }
	restarter.backupHeld = func() bool {
		release, busy, err := tryExclusiveLock(backupLock)
		if err == nil && !busy {
			release()
		}
		return busy
	}
	var logged []string
	var mu sync.Mutex
	restarter.logf = func(format string, args ...interface{}) {
		mu.Lock()
		logged = append(logged, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	restarter.maxWait = 100 * time.Millisecond
	restarter.schedule(0)
	time.Sleep(450 * time.Millisecond) // four times the longest wait
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("the Control Panel was restarted under a restore that outlasted the longest wait")
	}
	mu.Lock()
	if len(logged) == 0 || !strings.Contains(logged[0], "does not cut it off") {
		t.Fatalf("the log does not say why the restart waits: %v", logged)
	}
	mu.Unlock()
	// The restore ends; an install that hangs is what remains. It gets the longest wait from the last look that met
	// the restore, and is then restarted over.
	restore()
	ended := time.Now()
	waitFor(t, "the restart over work that never ends", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	if time.Since(ended) > 2*time.Second {
		t.Fatalf("the bound for a hung lifecycle lock is gone: %s", time.Since(ended))
	}
	mu.Lock()
	if last := logged[len(logged)-1]; !strings.Contains(last, "WITHOUT waiting any longer") {
		t.Fatalf("the forced restart was not logged: %v", logged)
	}
	mu.Unlock()
	archive()
}

// A backup or restore that hangs keeps the restart waiting for ever, by design. Until 0.6.15 the only sign was a
// log line every six hours. Now the log says so every heldReport (an hour), and the route's GET reports since when,
// for the Control Panel's health monitor; both end when the backup does.
func TestControlRestartSaysThatItWaitsUnderABackupOrRestore(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	backupLock := filepath.Join(t.TempDir(), "backups", ".operation.flock")
	restore := holdBackupOperation(t, backupLock)
	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, nil)
	restarter.tryIdle = func() (func(), bool, error) { return holdPlatformIdle(barrier, backupLock) }
	restarter.backupHeld = func() bool {
		release, busy, err := tryExclusiveLock(backupLock)
		if err == nil && !busy {
			release()
		}
		return busy
	}
	var logged []string
	var mu sync.Mutex
	restarter.logf = func(format string, args ...interface{}) {
		mu.Lock()
		logged = append(logged, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	hourly := func() int {
		mu.Lock()
		defer mu.Unlock()
		count := 0
		for _, line := range logged {
			if strings.Contains(line, "past its longest wait") {
				count++
			}
		}
		return count
	}
	status := func() controlRestartStatus {
		s := &Server{controlRestart: restarter}
		w := httptest.NewRecorder()
		s.handleControlRestart(w, httptest.NewRequest(http.MethodGet, "/api/control/restart", nil))
		var out controlRestartStatus
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatalf("answer %d %s", w.Code, w.Body.String())
		}
		return out
	}
	if got := status(); got.Waiting || got.BackupHeldSince != "" {
		t.Fatalf("nothing was asked for: %+v", got)
	}
	// The longest wait is far longer than the report, as on a box (six hours, one hour).
	restarter.maxWait, restarter.heldReport = 300*time.Millisecond, 50*time.Millisecond
	restarter.schedule(0)
	time.Sleep(100 * time.Millisecond)
	if got := status(); !got.Waiting || got.WaitingSince == "" || got.BackupHeldSince != "" || hourly() != 0 {
		t.Fatalf("within the longest wait: %+v %d", got, hourly())
	}
	waitFor(t, "the reports", func() bool { return hourly() >= 3 })
	got := status()
	if _, err := time.Parse(time.RFC3339, got.BackupHeldSince); !got.Waiting || err != nil {
		t.Fatalf("the status does not say that the restart waits under a restore: %+v", got)
	}
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("restarted under the restore")
	}
	mu.Lock()
	if !strings.Contains(logged[0], "does not cut it off") {
		t.Fatalf("the first report: %v", logged)
	}
	mu.Unlock()
	restore()
	waitFor(t, "the restart", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	waitFor(t, "the status after the restart", func() bool { got := status(); return !got.Waiting && got.BackupHeldSince == "" })
}

// The restore has ended and other work still holds the lifecycle: the status stops saying "under a backup" at the
// next look, and that work gets the longest wait before it is restarted over.
func TestControlRestartStopsSayingBackupWhenItHasEnded(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	backupLock := filepath.Join(t.TempDir(), "backups", ".operation.flock")
	restore := holdBackupOperation(t, backupLock)
	install, err := barrier.AdmitOrdinary()
	if err != nil {
		t.Fatal(err)
	}
	defer install()
	recorder := &restartRecorder{}
	restarter := testRestarter(t, barrier, recorder, nil)
	restarter.tryIdle = func() (func(), bool, error) { return holdPlatformIdle(barrier, backupLock) }
	restarter.backupHeld = func() bool {
		release, busy, err := tryExclusiveLock(backupLock)
		if err == nil && !busy {
			release()
		}
		return busy
	}
	restarter.maxWait, restarter.heldReport = 300*time.Millisecond, 50*time.Millisecond
	restarter.schedule(0)
	waitFor(t, "the status under the restore", func() bool { return restarter.status().BackupHeldSince != "" })
	restore()
	ended := time.Now()
	waitFor(t, "the status after the restore", func() bool { return restarter.status().BackupHeldSince == "" })
	if got := restarter.status(); !got.Waiting {
		t.Fatalf("the restart stopped waiting: %+v", got)
	}
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatal("the work that remained did not get its time")
	}
	waitFor(t, "the restart over work that never ends", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	if waited := time.Since(ended); waited < 200*time.Millisecond {
		t.Fatalf("restarted over the remaining work after %s", waited)
	}
}

// After a boot Spine's API service starts before the Control Panel's container does. The resumed restart used up
// its attempts (about five minutes) against a container that was not there and gave up; now it waits for the
// container and counts nothing meanwhile.
func TestControlRestartWaitsForTheContainerToRun(t *testing.T) {
	barrier := systemupdate.CoreLifecycleBarrier{Root: lifecycleRoot(t)}
	recorder := &restartRecorder{}
	var mu sync.Mutex
	running, looks := false, 0
	restarter := testRestarter(t, barrier, recorder, func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		if !running {
			return fmt.Errorf("Error: Instance is not running")
		}
		return nil
	})
	restarter.ready = func() bool { mu.Lock(); defer mu.Unlock(); looks++; return running }
	restarter.readyPoll = 5 * time.Millisecond
	restarter.restartAttempts, restarter.retryWait = 1, time.Millisecond
	restarter.pendingPath = filepath.Join(t.TempDir(), "control", ".restart-pending")
	if err := os.MkdirAll(filepath.Dir(restarter.pendingPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(restarter.pendingPath, []byte("asked before the reboot\n"), 0600); err != nil {
		t.Fatal(err)
	}
	restarter.resume()
	waitFor(t, "several looks at the container", func() bool { mu.Lock(); defer mu.Unlock(); return looks >= 10 })
	if restarts, _, _ := recorder.counts(); restarts != 0 {
		t.Fatalf("%d restarts of a container that does not run", restarts)
	}
	// Work can start while it waits: the locks are not even tried.
	for try := 0; try < 20; try++ {
		release, err := barrier.AdmitOrdinary()
		if err != nil {
			t.Fatalf("ordinary work is kept out while the restart waits for the container: %v", err)
		}
		release()
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	running = true
	mu.Unlock()
	waitFor(t, "the restart once the container runs", func() bool { restarts, _, _ := recorder.counts(); return restarts == 1 })
	waitFor(t, "the record to go", func() bool { _, err := os.Stat(restarter.pendingPath); return os.IsNotExist(err) })
}
