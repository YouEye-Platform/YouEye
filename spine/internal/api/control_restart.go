package api

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

// A Control Panel restart (after setup, a restore, a URL change or new YouEye ID clients) stops the Node process,
// and Next.js then waits for every open request before it exits: an app install started a moment earlier kept the
// stop waiting until systemd's 90 s SIGKILL, which killed the install midway, and the Control Panel answered no one
// meanwhile. So the restart waits until the platform is idle: no Control Panel lifecycle operation (install, update,
// uninstall, restore, setup) and no Spine backup or restore holds the lifecycle lock, no platform backup or restore
// holds the Control Panel's backup operation lock, and no System update or recovery owns the platform. It holds the
// admission gate, the lifecycle lock and the backup operation lock exclusively while it restarts, so none can start
// under it; they wait at the gate and run in the new process (a backup or restore asked for in that moment finds its
// lock busy and is refused before it writes anything). Requests that arrive while a restart waits share it.
//
// The wait has an end (maxWait, 6 hours). Locks say that something holds them, not that it is making progress: an
// install that hangs inside the Control Panel, a lifecycle directory that cannot be read and a lock file in an
// unexpected state all kept the restart waiting for ever, and with it whatever asked for it (a new address, new
// YouEye ID clients). After maxWait the restart is made without the locks, and the log says so. Six hours is longer
// than any install and any System update (its coordinator ends after 4 hours). Two things are never restarted
// under:
//
//   - a System update or recovery that owns the platform. It restarts the Control Panel itself, the Control Panel is
//     closed while it does, and it ends by itself (its coordinator, the watchdog, its recovery);
//   - a platform backup or restore (the backup operation lock is held). A restore of a large box and a backup to a
//     slow drive can take longer than six hours, and a restart there leaves a restore half-way or the only complete
//     copy unstored. Until 0.6.15 the bound cut them off. The lock is a kernel lease of the Control Panel's process,
//     so it is held exactly as long as that process is in the backup or restore. When the wait ends while it is
//     held, the six hours start again: what holds the other locks after the backup has ended gets its full time.
//     A backup or restore that hangs therefore keeps the restart waiting; restarting the Control Panel's service or
//     the box ends it, and the restart is made then. That must not go unseen (the only sign was a log line every
//     six hours): from the first time the wait ends under a backup or restore, the log says so once an hour
//     (heldReport), and status() reports since when, which the Control Panel's health monitor shows the owner
//     as an issue (GET /api/control/restart, lib/health/monitor.ts) until the restart is made or the lock is free.
//
// A restart is made only when the Control Panel's container runs (ready). After a boot Spine's API service starts
// before `youeye-control` does, and the resumed restart used up its attempts against a container that was not
// there yet; now it waits for the container and counts no failure meanwhile. A restart that then fails (Incus
// busy, systemd in the container not up yet) is tried again, restartAttempts times with a growing pause, and the
// record of the waiting restart is removed only when the service has been started again: a Spine that restarts in
// between, or an `api serve` that starts later, makes the restart.
//
// The backup operation lock is the Control Panel's kernel lease for a whole backup set or restore
// (lib/backup/platform-backup.ts): a platform backup takes the lifecycle lock once per archive and lets go of it
// between archives, so a System update can run between two archives instead of waiting for the whole set; only the
// restart, which would leave the set "creating" with half its archives, waits for the whole set.
type controlRestarter struct {
	// tryIdle takes the platform's lifecycle locks exclusively when nothing holds them (ok false: busy, try later).
	tryIdle func() (release func(), ok bool, err error)
	// restart restarts the Control Panel service and returns when systemd has started it again.
	restart func(ctx context.Context) error
	// kill ends what is left of a stop that outlasts stopGrace (requests that are not lifecycle work: the locks are
	// held), and start makes sure the service runs afterwards.
	kill  func() error
	start func(ctx context.Context) error
	// poll is how often a waiting restart tries again; stopGrace is how long a stop may wait for open requests (a user
	// operation that waits at the gate gives up after 30 s, so an idle stop ends well before).
	poll      time.Duration
	stopGrace time.Duration
	logf      func(format string, args ...interface{})
	// maxWait is how long a restart waits for the platform to be idle before it restarts anyway (0: for ever).
	// systemOwns reports that a System update or recovery owns the platform: nothing is restarted under it.
	maxWait    time.Duration
	systemOwns func() bool
	// backupHeld reports that a platform backup or restore holds the backup operation lock: it is never restarted
	// under either (nil: not asked). It is asked only once maxWait has passed.
	backupHeld func() bool
	// heldReport is how often a restart that waits past maxWait under a backup or restore looks at the lock again
	// and says so in the log (0: controlRestartHeldReport).
	heldReport time.Duration
	// ready reports that the Control Panel's container runs (nil: not asked). A restart waits for it, readyPoll
	// between two looks (0: poll).
	ready     func() bool
	readyPoll time.Duration
	// A restart that fails is tried again after retryWait, then twice that, and so on (at most retryMax),
	// restartAttempts times in all.
	restartAttempts int
	retryWait       time.Duration
	retryMax        time.Duration

	// pendingPath records a waiting restart on Data, so a Spine restart in the meantime does not drop it ("" in tests
	// that do not need it).
	pendingPath string

	mu      sync.Mutex
	waiting bool
	// askedAt is when the restart that waits was asked for; heldSince is when its longest wait first ended under a
	// backup or restore (zero: it has not, or that one has ended).
	askedAt   time.Time
	heldSince time.Time
}

// controlRestartStatus is what GET /api/control/restart answers.
type controlRestartStatus struct {
	// Waiting: a restart was asked for and has not been made.
	Waiting      bool   `json:"waiting"`
	WaitingSince string `json:"waiting_since,omitempty"`
	// BackupHeldSince: the restart has waited its longest wait and a platform backup or restore still runs; since
	// when that is known. A backup or restore that hangs shows here and nowhere else.
	BackupHeldSince string `json:"backup_held_since,omitempty"`
}

func (r *controlRestarter) status() controlRestartStatus {
	out := controlRestartStatus{}
	if r == nil {
		return out
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.waiting {
		return out
	}
	out.Waiting = true
	if !r.askedAt.IsZero() {
		out.WaitingSince = r.askedAt.UTC().Format(time.RFC3339)
	}
	if !r.heldSince.IsZero() {
		out.BackupHeldSince = r.heldSince.UTC().Format(time.RFC3339)
	}
	return out
}

// setHeld records (or, with the zero time, clears) since when the restart waits under a backup or restore.
func (r *controlRestarter) setHeld(since time.Time) {
	r.mu.Lock()
	r.heldSince = since
	r.mu.Unlock()
}

// controlRestartPendingPath: a restart was asked for and has not run yet (resumed by the next `api serve`).
const controlRestartPendingPath = "/var/lib/youeye/control/.restart-pending"

// controlRestartMaxWait, controlRestartHeldReport: see controlRestarter.
const (
	controlRestartMaxWait    = 6 * time.Hour
	controlRestartHeldReport = time.Hour
)

// controlBackupOperationLock is the Control Panel's backup operation lock (BACKUP_ROOT/.operation.flock), held for a
// whole platform backup set or restore.
const controlBackupOperationLock = "/var/lib/youeye/backups/.operation.flock"

func newControlRestarter(containerName string) *controlRestarter {
	incusSystemctl := func(ctx context.Context, args ...string) error {
		command := exec.CommandContext(ctx, "incus", append([]string{"exec", containerName, "--", "systemctl"}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %v: %w: %s", args, err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	return &controlRestarter{
		tryIdle: func() (func(), bool, error) {
			return holdPlatformIdle(systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}, controlBackupOperationLock)
		},
		restart: func(ctx context.Context) error { return incusSystemctl(ctx, "restart", "youeye-control") },
		kill: func() error {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			return incusSystemctl(ctx, "kill", "--signal=SIGKILL", "youeye-control")
		},
		start:     func(ctx context.Context) error { return incusSystemctl(ctx, "start", "youeye-control") },
		poll:      time.Second,
		stopGrace: 45 * time.Second,
		maxWait:   controlRestartMaxWait,
		systemOwns: func() bool {
			// A reservation that cannot be read is not one: it must not hold the restart for ever.
			_, err := (systemupdate.CoreLifecycleBarrier{Root: systemupdate.CoreAppLifecycleRoot}).Read()
			return err == nil
		},
		backupHeld: func() bool {
			// Asked only after maxWait, when the answer "free" is followed by the restart at once: the moment
			// in which this look holds the lock itself cannot refuse a backup that would have run.
			release, busy, err := tryExclusiveLock(controlBackupOperationLock)
			if err == nil && !busy {
				release()
			}
			return busy
		},
		ready: func() bool {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			output, err := exec.CommandContext(ctx, "incus", "list", "^"+containerName+"$", "--format", "csv", "-c", "s").Output()
			return err == nil && strings.TrimSpace(string(output)) == "RUNNING"
		},
		readyPoll:       5 * time.Second,
		restartAttempts: 6,
		retryWait:       10 * time.Second,
		retryMax:        5 * time.Minute,
		logf:            func(format string, args ...interface{}) { fmt.Printf("[control-restart] "+format+"\n", args...) },
		pendingPath:     controlRestartPendingPath,
	}
}

// resume schedules the restart a previous `api serve` was waiting to make.
func (r *controlRestarter) resume() {
	if r == nil || r.pendingPath == "" {
		return
	}
	if _, err := os.Stat(r.pendingPath); err == nil {
		r.logf("resuming the Control Panel restart asked for before Spine restarted")
		r.schedule(0)
	}
}

// schedule starts a restart after delay, unless one is already waiting (it is shared: it has not restarted yet, so
// it includes whatever the caller changed). It never blocks.
func (r *controlRestarter) schedule(delay time.Duration) {
	r.mu.Lock()
	if r.waiting {
		r.mu.Unlock()
		return
	}
	r.waiting = true
	r.askedAt, r.heldSince = time.Now(), time.Time{}
	r.mu.Unlock()
	if r.pendingPath != "" {
		if err := os.MkdirAll(filepath.Dir(r.pendingPath), 0700); err == nil {
			_ = os.WriteFile(r.pendingPath, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0600)
		}
	}
	go r.run(delay)
}

func (r *controlRestarter) run(delay time.Duration) {
	time.Sleep(delay)
	started := time.Now()
	// waitFrom is where the longest wait counts from: the start, or the last time it ended under a backup or restore.
	waitFrom := started
	lastReport := started
	// heldSince: the longest wait first ended under a backup or restore then (zero: not so far, or that one has
	// ended); heldLook is the last look at its lock since.
	var heldSince, heldLook time.Time
	heldReport := r.heldReport
	if heldReport <= 0 {
		heldReport = controlRestartHeldReport
	}
	failures := 0
	// containerRuns: ready has said yes since the last failure. It is asked before the locks are tried, so the
	// look (an incus command) never keeps work out.
	containerRuns, saidWaiting := r.ready == nil, false
	for {
		if !containerRuns {
			if containerRuns = r.ready(); !containerRuns {
				// Nothing to restart yet (after a boot the container starts after this service): not a failure.
				if !saidWaiting {
					r.logf("the Control Panel's container is not running yet; its restart waits for it")
					saidWaiting = true
				}
				pause := r.readyPoll
				if pause <= 0 {
					pause = r.poll
				}
				time.Sleep(pause)
				continue
			}
		}
		release, ok, err := r.tryIdle()
		if err != nil && time.Since(lastReport) >= 5*time.Minute {
			r.logf("cannot read the platform lifecycle, still waiting to restart the Control Panel: %v", err)
			lastReport = time.Now()
		}
		forced := false
		if !ok && !heldSince.IsZero() && time.Since(heldLook) >= heldReport && r.backupHeld != nil {
			// Once an hour, not every six: a backup or restore that hangs keeps this waiting for ever, by design,
			// and somebody has to learn of it.
			heldLook = time.Now()
			if r.backupHeld() {
				r.logf("a platform backup or restore is still running; the Control Panel restart asked for %s ago has waited for it past its longest wait since %s. If it hangs, restarting the Control Panel's service or the box ends it", time.Since(started).Round(time.Minute), heldSince.UTC().Format(time.RFC3339))
				waitFrom, lastReport = time.Now(), time.Now()
			} else {
				// It has ended: what holds the other locks now gets the longest wait from the last look that met it.
				heldSince = time.Time{}
				r.setHeld(heldSince)
			}
		}
		if !ok && r.maxWait > 0 && time.Since(waitFrom) >= r.maxWait {
			if r.systemOwns != nil && r.systemOwns() {
				if time.Since(lastReport) >= 5*time.Minute {
					r.logf("a System update or recovery owns the platform; the Control Panel restart asked for %s ago waits for its end", time.Since(started).Round(time.Minute))
					lastReport = time.Now()
				}
			} else if r.backupHeld != nil && r.backupHeld() {
				r.logf("a platform backup or restore is still running; the Control Panel restart asked for %s ago does not cut it off and waits for its end", time.Since(started).Round(time.Minute))
				waitFrom, lastReport, heldLook = time.Now(), time.Now(), time.Now()
				if heldSince.IsZero() {
					heldSince = heldLook
					r.setHeld(heldSince)
				}
			} else {
				forced, release = true, func() {}
			}
		}
		if forced {
			reason := "app or platform work has not ended"
			if err != nil {
				reason = "the platform lifecycle cannot be read (" + err.Error() + ")"
			}
			r.logf("restarting the Control Panel WITHOUT waiting any longer: %s after %s; work that still runs in it is cut off", reason, time.Since(started).Round(time.Minute))
		}
		if ok || forced {
			// A request from here on wants a restart after its own change, which this one may precede.
			r.mu.Lock()
			r.waiting = false
			r.heldSince = time.Time{}
			r.mu.Unlock()
			heldSince = time.Time{}
			// Only a first try waited for work; a retry waited for its own pause and has said so.
			if waited := time.Since(started); ok && failures == 0 && waited >= 2*time.Second {
				r.logf("restarting the Control Panel after %s of app or platform work", waited.Round(time.Second))
			}
			restartErr := r.restartNow()
			release()
			if restartErr == nil {
				// Only now: until the service runs again, the next `api serve` would have to make this restart.
				// A request that arrived meanwhile has written the record again and waits itself.
				r.mu.Lock()
				if !r.waiting && r.pendingPath != "" {
					_ = os.Remove(r.pendingPath)
				}
				r.mu.Unlock()
				return
			}
			failures++
			// The container may be what is missing: look before the next try.
			containerRuns = r.ready == nil
			if r.restartAttempts > 0 && failures >= r.restartAttempts {
				r.logf("the Control Panel restart failed %d times (%v); giving up until Spine's API service starts again", failures, restartErr)
				return
			}
			pause := r.retryWait << (failures - 1)
			if pause <= 0 || (r.retryMax > 0 && pause > r.retryMax) {
				pause = r.retryMax
			}
			if pause <= 0 {
				pause = r.poll
			}
			r.logf("the Control Panel restart failed (%v); trying again in %s", restartErr, pause)
			r.mu.Lock()
			if r.waiting {
				// A newer request waits already: its restart is this one too.
				r.mu.Unlock()
				return
			}
			r.waiting = true
			r.mu.Unlock()
			time.Sleep(pause)
			continue
		}
		if err == nil && time.Since(lastReport) >= 5*time.Minute {
			r.logf("app or platform work is running; the Control Panel restarts when it ends")
			lastReport = time.Now()
		}
		time.Sleep(r.poll)
	}
}

// restartNow restarts the service and returns nil when it has been started again.
func (r *controlRestarter) restartNow() error {
	ctx, cancel := context.WithTimeout(context.Background(), r.stopGrace)
	err := r.restart(ctx)
	deadline := errors.Is(ctx.Err(), context.DeadlineExceeded)
	cancel()
	if err == nil {
		return nil
	}
	if !deadline {
		return err
	}
	// Only open requests keep the stop waiting now: no lifecycle work runs while the locks are held.
	r.logf("the Control Panel did not stop within %s; ending its remaining requests", r.stopGrace)
	if err := r.kill(); err != nil {
		r.logf("kill failed: %v", err)
	}
	startCtx, cancelStart := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelStart()
	if err := r.start(startCtx); err != nil {
		return fmt.Errorf("start after the restart: %w", err)
	}
	return nil
}

// holdPlatformIdle takes the admission gate and the lifecycle lock of the Control Panel's lifecycle directory
// exclusively without waiting (the protocol of systemupdate.CoreLifecycleBarrier: ordinary work holds the lifecycle
// lock shared and passes the gate shared; an exclusive holder of the gate keeps new work out), then the backup
// operation lock (backupLock, "" for none), and checks that no System update or recovery owns the platform. ok is
// false when anything holds them or one does. The backup lock comes last: a platform backup holds it and then waits
// at the gate for each archive, so it is never waited for while holding the gate.
func holdPlatformIdle(barrier systemupdate.CoreLifecycleBarrier, backupLock string) (release func(), ok bool, err error) {
	gate, busy, err := tryExclusiveLock(filepath.Join(barrier.Root, "core-admission.flock"))
	if err != nil || busy {
		return nil, false, err
	}
	lifecycle, busy, err := tryExclusiveLock(filepath.Join(barrier.Root, "core-lifecycle.flock"))
	if err != nil || busy {
		gate()
		return nil, false, err
	}
	backup := func() {}
	if backupLock != "" {
		backup, busy, err = tryExclusiveLock(backupLock)
		if err != nil || busy {
			lifecycle()
			gate()
			if err != nil {
				return nil, false, fmt.Errorf("backup operation lock: %w", err)
			}
			return nil, false, nil
		}
	}
	release = func() { backup(); lifecycle(); gate() }
	if _, err := barrier.Read(); !errors.Is(err, os.ErrNotExist) {
		release()
		if err != nil {
			return nil, false, fmt.Errorf("System lifecycle reservation: %w", err)
		}
		return nil, false, nil
	}
	// An independent copy's reservation does not count: the copy itself changes the destination's address and waits
	// for the restart that loads it (lib/copy/platform.ts).
	return release, true, nil
}

// tryExclusiveLock flocks path exclusively without waiting. The file must be what the lifecycle protocol keeps
// there: a private, empty regular file owned by this user (it is created so when missing, as the others do).
func tryExclusiveLock(path string) (release func(), busy bool, err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, false, err
	}
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, false, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, false, err
	}
	stat, statOK := info.Sys().(*syscall.Stat_t)
	if !statOK || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() != 0 || stat.Nlink != 1 || int(stat.Uid) != os.Geteuid() {
		file.Close()
		return nil, false, fmt.Errorf("unsafe app lifecycle lock %s", path)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, true, nil
		}
		return nil, false, err
	}
	return func() { _ = syscall.Flock(fd, syscall.LOCK_UN); _ = file.Close() }, false, nil
}
