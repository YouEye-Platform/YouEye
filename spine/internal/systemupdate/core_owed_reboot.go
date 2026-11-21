package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// coreOwedRebootWait: how long after a host step's child ended (or after the
// last request) a restart that has not happened is asked for again. A shutdown
// stops the API service and every `update core` command within seconds, so
// whoever still runs this after two minutes is not inside one.
var coreOwedRebootWait = 2 * time.Minute

// coreOwedLingeringWait: how long processes that a host step's child left in
// its unit are waited for before the step is judged (the watchdog waits as
// long before it counts such a step as lost).
var coreOwedLingeringWait = 30 * time.Minute

// coreOwedRebootRequests: how often RebootAgain asks for the restart of
// activate-host again before it gives the update up.
const coreOwedRebootRequests = 2

// coreHostActivationFailed is the error of an activate-host child whose
// activation did not complete.
const coreHostActivationFailed = "host activation has no exact pending receipt"

type coreOwedReboot struct {
	BootID   string `json:"boot_id"`
	Requests int    `json:"requests"`
}

// RebootAgain judges a started activate-host or recovery-host whose outcome is
// unknown. Both end in a restart of the machine, and only the next boot can
// say how they went, so the coordinator leaves them alone. That left a box
// held, with the Control Panel closed, when the restart never came: `systemctl
// reboot` failed, the shutdown was called off, the child was killed first, or
// the activation itself failed before it asked for anything.
//
// It acts only on positive evidence: the step's child does not run any more
// (ChildState; processes it left behind without a last word are waited for,
// coreOwedLingeringWait), and it was launched in this boot (or never), so the
// machine has not restarted since. Then:
//
//   - activate-host, and the host update is pending in this boot (the new
//     slot is selected for one counted trial boot, which is everything the
//     step does before the restart): the restart is asked for again. That is
//     what a person would do and it repeats nothing: the next boot decides as
//     before, and a new slot that does not come up falls back by itself. After
//     coreOwedRebootRequests such requests the machine evidently cannot be
//     restarted this way, and an error is returned: the coordinator restores
//     the previous release, which needs no restart here (the old slot runs)
//     and opens the box again.
//   - activate-host, and the host update is not pending or the child said that
//     the activation failed: it failed or never ran. A restart would boot the old slot and prove nothing. An
//     error is returned at once, for the same recovery.
//   - recovery-host, and its record says the restart into the previous slot
//     was asked for: the boot selection and the request are repeated (both
//     repeat safely). There is nothing to fall back to, so this is not
//     counted out. A record in any other state is left for a person.
//
// It reports whether it asked for a restart. Nothing is asked for within
// coreOwedRebootWait of the child's end or of the last request, so the
// coordinator that has just seen the child ask, and a person who runs `resume`
// during the shutdown, change nothing. Anything it cannot read is "not owed".
func (r NativeCoreRuntime) RebootAgain(ctx context.Context, j CoreJournal, s CoreStep) (bool, error) {
	if s.State != "started" || (s.Name != "activate-host" && s.Name != "recovery-host") || r.Validate() != nil {
		return false, nil
	}
	lingering := false
	switch r.Runner.ChildState(ctx, j, s) {
	case CoreChildGone:
	case CoreChildLingering:
		lingering = true
	default:
		return false, nil
	}
	boot, err := r.Runner.boot()
	if err != nil {
		return false, nil
	}
	launch, err := r.Runner.read(j, s)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err == nil && launch.BootID != boot {
		return false, nil // the machine has restarted since: the boot is the outcome
	}
	// The newest thing the child left (its launch record and its last word).
	path := r.Runner.path(j, s) + ".reboots"
	child, childName := time.Time{}, ""
	for _, name := range []string{r.Runner.path(j, s) + ".result", r.Runner.path(j, s)} {
		if info, err := os.Lstat(name); err == nil && info.ModTime().After(child) {
			child, childName = info.ModTime(), name
		}
	}
	// The child's main process ended without a last word and processes it started are still in its unit. They
	// are waited for, coreOwedLingeringWait from the child's launch; after that the step is judged as if nothing
	// ran (a restart ends them, and so does the fence of the recovery). Without this such a step was never
	// judged: the watchdog started a continuation every time and each ended here, with the box held.
	//
	// The wait counts from what the child left only. A request made here must not start it again: it did, and
	// counting out took a lingering wait per request instead of coreOwedRebootWait. A time in the future is a
	// clock that was set back: the wait begins anew (coreOwedAge).
	if lingering {
		if child.IsZero() || coreOwedAge(childName, child) < coreOwedLingeringWait {
			return false, nil
		}
	}
	if s.Name == "activate-host" {
		host, err := loadJournal(r.Host.config.JournalPath)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		// The activation records "pending" before it selects the boot entries: a
		// child that says the activation failed did not get that far.
		if err != nil || host.CoreManifestSHA256 != j.ManifestSHA256 || host.Phase != PhasePending || host.ActivationBootID != boot ||
			strings.Contains(r.Runner.RetainedEvidence(j, s), coreHostActivationFailed) {
			return false, fmt.Errorf("the new system image was not activated and no restart is pending")
		}
	}
	// Not yet: the last request, or before the first one the child, is recent. Once a request was made its time
	// alone counts: the child's time, when a clock that was set back puts it in the future, said nothing about
	// the request, and every look asked again until the update was counted out within seconds.
	last, lastName := child, childName
	if info, err := os.Lstat(path); err == nil {
		last, lastName = info.ModTime(), path
	}
	if !last.IsZero() && coreOwedAge(lastName, last) < coreOwedRebootWait {
		return false, nil
	}
	record := coreOwedReboot{BootID: boot}
	if raw, err := ReadCoreState(path, 4096); err == nil {
		var old coreOwedReboot
		if json.Unmarshal(raw, &old) == nil && old.BootID == boot && old.Requests > 0 {
			record = old
		}
	}
	if s.Name == "activate-host" && record.Requests >= coreOwedRebootRequests {
		return false, fmt.Errorf("the restart into the new system image was asked for %d times and did not happen", record.Requests+1)
	}
	record.Requests++
	raw, err := json.Marshal(record)
	if err != nil {
		return false, nil
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return false, nil
	}
	if err = atomicWrite(path, raw, 0600); err != nil {
		return false, nil
	}
	if s.Name == "recovery-host" {
		return r.Host.rebootCoreRecoveryHostAgain(ctx, j.RequestID)
	}
	if _, err = r.Runner.capture(ctx, "systemctl", "reboot"); err != nil {
		return false, fmt.Errorf("the restart into the new system image cannot be requested: %w", err)
	}
	return true, nil
}

// coreOwedAge is how long ago the time of a file was. A time in the future is a clock that was set back and says
// nothing about how long ago: the wait begins anew from now (the file gets the time of now), so it neither ends at
// once (which judged a step whose processes still ran, and asked for restarts without a pause) nor lasts for as long
// as the clock was set back. When the time cannot be set, the wait counts as over.
func coreOwedAge(name string, at time.Time) time.Duration {
	now := time.Now()
	if !at.After(now) {
		return now.Sub(at)
	}
	if os.Chtimes(name, now, now) != nil {
		return coreOwedLingeringWait
	}
	return 0
}

// rebootCoreRecoveryHostAgain repeats what RecoverCoreHost did last on the new
// slot: it selects the previous slot and asks for the restart. Only a record
// that says "reboot-requested" for this request allows it.
func (m *Manager) rebootCoreRecoveryHostAgain(ctx context.Context, request string) (bool, error) {
	unlock, err := m.lock()
	if err != nil {
		return false, nil
	}
	defer unlock()
	raw, err := ReadCoreState(filepath.Join(m.config.CoreStatePath, "host-recovery", fmt.Sprintf("%x.json", sha256.Sum256([]byte(request)))), 16384)
	if err != nil {
		return false, nil
	}
	var record coreHostRecovery
	if json.Unmarshal(raw, &record) != nil || record.Schema != "youeye.core-host-recovery.v1" || record.RequestID != request || record.State != "reboot-requested" || (strings.ToLower(record.ActiveSlot) != "a" && strings.ToLower(record.ActiveSlot) != "b") {
		return false, nil
	}
	for _, args := range [][]string{{"set-default", stableEntryID(record.ActiveSlot)}, {"set-oneshot", stableEntryID(record.ActiveSlot)}} {
		if _, err = m.config.Run(ctx, "bootctl", args...); err != nil {
			return false, fmt.Errorf("the previous system image cannot be selected for the restart: %w", err)
		}
	}
	if _, err = m.config.Run(ctx, "systemctl", "--no-block", "reboot"); err != nil {
		return false, fmt.Errorf("the restart into the previous system image cannot be requested: %w", err)
	}
	return true, nil
}
