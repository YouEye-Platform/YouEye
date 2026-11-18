package systemupdate

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CoreContinuationWatchdog starts the continuation of a System update again
// when its coordinator was lost while the request holds the platform: the
// Control Panel and the dashboard are closed and app work is refused. Without
// it such a request waits for a reboot (the boot unit resumes it) or for
// `youeye update core resume` on the console, with no Control Panel to say so.
//
// The API service runs Check once before it serves and then once a minute.
// Check does what the console command does, through the runner the API uses
// for the Control Panel's "resume", and only when every one of these holds:
//
//   - the current request is one of two kinds. Between two steps: a service
//     update (no restart) in phase `applying` with no recovery graph, whose
//     checkpoint has succeeded (the services are held; before that the Control
//     Panel is up and the owner decides) and with no step started or failed (a
//     started step is settled by observing it, never by this). Finished and
//     not released: a request in phase `committed` or `rolled-back` whose
//     release of the holds did not finish (see coreReleaseLost); `resume` of
//     such a request does nothing but that release;
//   - the journal state is not the one the first look found. That state was
//     there before this API service: after a boot the boot unit continues it
//     (for a finished request it runs the release), and after a restart of
//     the service alone it is left for a person, as it was before the restart;
//   - this watchdog has seen the same journal state for at least Idle (a live
//     coordinator moves on within seconds);
//   - no process on the host runs any `update core` command: no continuation
//     unit, boot unit, action unit or console session is at work.
//
// Journal states are compared as text (request and change time) and never as
// times, and the wait is measured between this watchdog's own looks on the
// monotonic clock. A wall clock that starts wrong and is corrected later (no
// RTC battery, NTP) can therefore neither make a state from before a boot look
// recent nor keep the watchdog silent.
//
// The command ID is derived from the request and the journal's change time, so
// one journal state is acted on at most once: this value remembers it, and the
// runner's retained delivery receipt refuses a second launch even after the
// API service restarted. A continuation that dies again without changing the
// journal is therefore left for a person.
type CoreContinuationWatchdog struct {
	Root string
	// Lifecycle is the app lifecycle directory (CoreAppLifecycleRoot), where a
	// request's reservation lives.
	Lifecycle string
	Idle      time.Duration
	// Now is for tests. Without it the wait is measured with time.Now, whose
	// values carry the monotonic clock.
	Now func() time.Time
	// Coordinating reports whether any `update core` command is running.
	Coordinating func() (bool, error)
	// Start is CoreControlRunner.Start.
	Start func(ctx context.Context, request, command string) (CoreControlObservation, error)

	// looked: a look has read the journal or found that there is none.
	// inherited is the journal state that look found ("" for none).
	looked    bool
	inherited string
	// seen is the journal state being watched, since when this watchdog first
	// saw it.
	seen    string
	since   time.Time
	handled string
	why     string
}

const (
	coreWatchdogBetweenSteps = "the request waited between two steps with no coordinator"
	coreWatchdogNotReleased  = "the finished request still held the Control Panel and app work with no coordinator"
)

// Why says what the last continuation was started for.
func (w *CoreContinuationWatchdog) Why() string { return w.why }

// coreContinuationLost: the journal of a held service update that waits
// between two steps.
func coreContinuationLost(j CoreJournal) bool {
	if j.Phase != "applying" || j.RestartRequired || len(j.RecoverySteps) > 0 {
		return false
	}
	held := false
	for _, step := range j.Steps {
		if step.State == "started" || step.State == "failed" {
			return false
		}
		if step.Name == "checkpoint" && step.State == "succeeded" {
			held = true
		}
	}
	return held
}

// coreReleaseLost: a committed or rolled-back request whose release did not
// finish (ReleaseCompleted failed, or its process ended first). The release
// restores the power settings, opens the ingress gate, removes the lifecycle
// reservation last and then records `released` in the checkpoint record. A
// reservation that still names this request, beside a checkpoint record in a
// state the release continues from, therefore proves that holds remain. Both
// are files on this machine: Incus, nft and the network are not asked.
//
// Everything else is not lost: a request that was released (no reservation of
// its own, whatever its record says, which covers every request finished by an
// earlier Spine), one that never held anything (cancelled, or with unchanged
// payloads) and one whose files cannot be read.
func coreReleaseLost(root, lifecycle string, j CoreJournal) bool {
	if (j.Phase != "committed" && j.Phase != "rolled-back") || j.NoOp || j.MetadataOnly {
		return false
	}
	reservation, err := (CoreLifecycleBarrier{Root: lifecycle}).Read()
	if err != nil || reservation.RequestID != j.RequestID || reservation.ManifestSHA256 != j.ManifestSHA256 {
		return false
	}
	record, err := (NativeCoreCheckpoint{Root: root}).Read(j)
	return err == nil && (record.CompletionState == "" || record.CompletionState == "releasing" || record.CompletionState == "ready")
}

func (w *CoreContinuationWatchdog) lost(j CoreJournal) string {
	if coreContinuationLost(j) {
		return coreWatchdogBetweenSteps
	}
	if coreReleaseLost(w.Root, w.Lifecycle, j) {
		return coreWatchdogNotReleased
	}
	return ""
}

// Check looks once. It returns the command ID it started a continuation with,
// or "" when it started none.
func (w *CoreContinuationWatchdog) Check(ctx context.Context) (string, error) {
	if w.Coordinating == nil || w.Start == nil || w.Idle <= 0 || !filepath.IsAbs(w.Root) || !filepath.IsAbs(w.Lifecycle) {
		return "", fmt.Errorf("continuation watchdog is not configured")
	}
	now := time.Now()
	if w.Now != nil {
		now = w.Now()
	}
	m := CoreManager{Root: w.Root}
	j, err := m.Read()
	if errors.Is(err, os.ErrNotExist) {
		// No request: one that appears later began under this API service.
		w.looked, w.seen = true, ""
		return "", nil
	}
	if err != nil {
		// Unreadable: nothing is learned. If this was the first look, the first
		// state that can be read counts as the one that was already there.
		return "", nil
	}
	state := j.RequestID + "\x00" + j.UpdatedAt
	if !w.looked {
		w.looked, w.inherited = true, state
	}
	if state == w.inherited {
		return "", nil
	}
	if state != w.seen {
		w.seen, w.since = state, now
		return "", nil
	}
	if state == w.handled || now.Sub(w.since) < w.Idle || w.lost(j) == "" {
		return "", nil
	}
	if busy, err := w.Coordinating(); err != nil || busy {
		return "", nil
	}
	// Nothing moved while the processes were listed, and the request is still
	// lost: a release that finished meanwhile has removed its reservation.
	again, err := m.Read()
	if err != nil || again.RequestID != j.RequestID || again.UpdatedAt != j.UpdatedAt {
		return "", nil
	}
	why := w.lost(again)
	if why == "" {
		return "", nil
	}
	w.handled, w.why = state, why
	command := fmt.Sprintf("watchdog-%x", sha256.Sum256([]byte(state)))[:41]
	_, err = w.Start(ctx, j.RequestID, command)
	return command, err
}

// CoreCommandRunning reports whether any process visible under proc (normally
// /proc) has the consecutive arguments `update core`: every coordinator
// (`activate`, `resume`, `recover`, `stage`), every action (`run-action`) and
// every other System update command, however it was started. A process that
// ends while it is read is skipped; when the list itself cannot be read the
// answer is "yes".
func CoreCommandRunning(proc string) (bool, error) {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return true, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "" || strings.Trim(name, "0123456789") != "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(proc, name, "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(string(raw), "\x00")
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "update" && args[i+1] == "core" {
				return true, nil
			}
		}
	}
	return false, nil
}
