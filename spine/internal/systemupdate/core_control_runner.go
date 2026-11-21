package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// CoreControlRunner detaches a reconciliation command from an HTTP connection.
// Each delivery ID launches at most once. The command itself reads the retained
// graph; it cannot replay an uncertain native action or select another release.
type CoreControlRunner struct {
	Root       string
	Executable string
	Capture    func(context.Context, string, ...string) ([]byte, error)
}
type CoreControlReceipt struct {
	Schema         string `json:"schema"`
	RequestID      string `json:"request_id"`
	CommandID      string `json:"command_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
	Unit           string `json:"unit"`
	Executable     string `json:"executable"`
}
type CoreControlObservation struct {
	RequestID string `json:"request_id"`
	CommandID string `json:"command_id"`
	State     string `json:"state"`
}

func (r CoreControlRunner) capture(ctx context.Context, name string, args ...string) ([]byte, error) {
	if r.Capture != nil {
		return r.Capture(ctx, name, args...)
	}
	return captureCoreNative(ctx, name, args...)
}
func (r CoreControlRunner) Start(ctx context.Context, request, command string) (CoreControlObservation, error) {
	unknown := CoreControlObservation{RequestID: request, CommandID: command, State: "unknown"}
	if !filepath.IsAbs(r.Root) || !filepath.IsAbs(r.Executable) || strings.ContainsAny(r.Executable, "\n\r$%") || !coreRequestPattern.MatchString(request) || !coreRequestPattern.MatchString(command) {
		return unknown, fmt.Errorf("exact native continuation identities required")
	}
	j, err := (CoreManager{Root: r.Root}).Read()
	if err != nil || j.RequestID != request {
		return unknown, fmt.Errorf("current retained request required for continuation")
	}
	unit := fmt.Sprintf("youeye-core-control-%x.service", sha256.Sum256([]byte(request+"\x00"+command)))
	receipt := CoreControlReceipt{Schema: "youeye.core-control.v1", RequestID: request, CommandID: command, ManifestSHA256: j.ManifestSHA256, Unit: unit, Executable: r.Executable}
	root := filepath.Join(r.Root, "controllers")
	if err = os.MkdirAll(root, 0700); err != nil {
		return unknown, err
	}
	path := filepath.Join(root, unit+".json")
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return unknown, err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return unknown, fmt.Errorf("continuation delivery is already being reconciled")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	raw, err := ReadCoreState(path, 16384)
	if err == nil {
		var prior CoreControlReceipt
		if json.Unmarshal(raw, &prior) != nil || prior != receipt {
			return unknown, fmt.Errorf("retained continuation identity changed")
		}
		observed, err := r.observe(ctx, receipt)
		if observed.State == "absent" {
			observed.State = "unknown"
		}
		return observed, err
	}
	if !errors.Is(err, os.ErrNotExist) {
		return unknown, err
	}
	// A pre-existing unit without this native launch receipt cannot be adopted.
	observation, err := r.observe(ctx, receipt)
	if err != nil {
		return unknown, err
	}
	if observation.State != "absent" {
		return unknown, fmt.Errorf("unowned continuation unit already exists")
	}
	raw, _ = json.Marshal(receipt)
	if err = atomicWrite(path, raw, 0600); err != nil {
		return unknown, err
	}
	// Standard error goes to the system journal, as in the boot unit: the coordinator writes there only what it
	// decided at the hand-over and the error it ended with (and the launcher, why it does not run the selected
	// Spine), a few lines for a whole request. Standard output is the whole journal document,
	// printed when the command ends; nothing reads it here.
	args := []string{"--quiet", "--no-ask-password", "--unit=" + unit, "--description=YouEye core continuation " + unit, "--service-type=exec", "--remain-after-exit", "--uid=root", "--working-directory=/", "--property=KillMode=control-group", "--property=Restart=no", "--property=RuntimeMaxSec=4h", "--property=UMask=0077", "--property=StandardOutput=null", "--property=StandardError=journal", "--", r.Executable, "update", "core", "resume", "--request", request}
	_, launchErr := r.capture(ctx, "systemd-run", args...)
	observed, err := r.observe(ctx, receipt)
	if err != nil {
		return unknown, err
	}
	if observed.State == "absent" {
		observed.State = "unknown"
	}
	if launchErr != nil && observed.State == "unknown" {
		return observed, fmt.Errorf("continuation acknowledgement unavailable; reconcile the same command ID")
	}
	return observed, nil
}

// Delivered reports whether a continuation with this command ID was ever
// launched for the request: its delivery receipt is retained. It reads one
// file name; an unusable identity is "no".
func (r CoreControlRunner) Delivered(request, command string) bool {
	if !filepath.IsAbs(r.Root) || !coreRequestPattern.MatchString(request) || !coreRequestPattern.MatchString(command) {
		return false
	}
	unit := fmt.Sprintf("youeye-core-control-%x.service", sha256.Sum256([]byte(request+"\x00"+command)))
	_, err := os.Lstat(filepath.Join(r.Root, "controllers", unit+".json"))
	return err == nil
}

// Forget removes what a continuation that has ended left behind: its transient
// unit (RemainAfterExit keeps it loaded, and a failed one stays failed) and its
// delivery receipt, so that the same command ID can be delivered again. The
// watchdog's attempts without end use it: they would otherwise leave a unit
// and a receipt every half hour for as long as a box stays closed.
//
// It refuses while the unit runs, for a unit in any state that is not clearly
// ended (starting, stopping), and for a unit it cannot observe or that is not
// this delivery's. The unit goes first and the receipt last: a Forget that
// was cut short is finished by the next one. No receipt is nothing to forget.
func (r CoreControlRunner) Forget(ctx context.Context, request, command string) error {
	if !filepath.IsAbs(r.Root) || !coreRequestPattern.MatchString(request) || !coreRequestPattern.MatchString(command) {
		return fmt.Errorf("exact native continuation identities required")
	}
	unit := fmt.Sprintf("youeye-core-control-%x.service", sha256.Sum256([]byte(request+"\x00"+command)))
	path := filepath.Join(r.Root, "controllers", unit+".json")
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if errors.Is(err, os.ErrNotExist) {
		return nil // no controllers directory: nothing was ever delivered
	}
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("continuation delivery is already being reconciled")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	raw, err := ReadCoreState(path, 16384)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var receipt CoreControlReceipt
	if json.Unmarshal(raw, &receipt) != nil || receipt.Schema != "youeye.core-control.v1" || receipt.RequestID != request || receipt.CommandID != command || receipt.Unit != unit {
		return fmt.Errorf("retained continuation identity changed")
	}
	observed, err := r.observe(ctx, receipt)
	if err != nil {
		return err
	}
	if observed.State == "running" {
		return fmt.Errorf("the continuation still runs")
	}
	// Anything between the states that are told apart (a unit that starts or stops, a main process that is
	// reported in neither way) may still run or come to run: stopping it would end a coordinator in the middle
	// of a step. It is left for the next look.
	if observed.State != "absent" && observed.State != "settled" && observed.State != "failed" {
		return fmt.Errorf("the continuation unit is neither running nor ended")
	}
	if observed.State != "absent" {
		// An exited unit is unloaded by stop, a failed one by reset-failed; each
		// may have nothing to do, and the look after them is what counts.
		_, _ = r.capture(ctx, "systemctl", "stop", unit)
		_, _ = r.capture(ctx, "systemctl", "reset-failed", unit)
		if observed, err = r.observe(ctx, receipt); err != nil {
			return err
		}
		if observed.State != "absent" {
			return fmt.Errorf("the continuation unit could not be removed")
		}
	}
	return os.Remove(path)
}

// CoreBootContinuationUnit continues a retained request after a reboot.
const CoreBootContinuationUnit = "youeye-core-update.service"

var coreFinishedUnitName = regexp.MustCompile(`^youeye-core-(control-)?[0-9a-f]{64}\.service$`)

// ResetFailedUnits clears the failed state of the transient units a finished
// request left behind: its action units (youeye-core-*) and its continuation
// units (youeye-core-control-*). Without this they stay in `systemctl --failed`
// until the next reboot, long after the request was cancelled, rolled back or
// committed. It runs only for a request in a terminal phase. Such a request is
// never advanced, fenced or settled again, and observation of a finished
// action reads its retained terminal receipt before it looks at any unit, so
// nothing depends on these units any more. A unit that is not failed (still
// running, or exited cleanly) is left as it is: reset-failed does not touch it.
// Best effort: an error changes nothing about the request.
func (r CoreSystemdRunner) ResetFailedUnits(ctx context.Context, j CoreJournal) []string {
	if j.Phase != "committed" && j.Phase != "cancelled" && j.Phase != "rolled-back" {
		return nil
	}
	units := []string{}
	for _, steps := range [][]CoreStep{j.Steps, j.RecoverySteps} {
		for _, step := range steps {
			if step.State != "pending" {
				units = append(units, r.unit(j, step))
			}
		}
	}
	root := filepath.Join(r.Root, "controllers")
	entries, _ := os.ReadDir(root)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "youeye-core-control-") || !strings.HasSuffix(name, ".service.json") {
			continue
		}
		var receipt CoreControlReceipt
		raw, err := ReadCoreState(filepath.Join(root, name), 16384)
		if err != nil || json.Unmarshal(raw, &receipt) != nil || receipt.RequestID != j.RequestID || receipt.Unit+".json" != name {
			continue
		}
		units = append(units, receipt.Unit)
	}
	named := []string{"reset-failed"}
	for _, unit := range units {
		if coreFinishedUnitName.MatchString(unit) {
			named = append(named, unit)
		}
	}
	// Without a unit name, reset-failed would clear every unit on the host.
	if len(named) == 1 {
		return nil
	}
	// The boot continuation (`youeye-core-update.service`) fails when the boot finds
	// the request needing recovery, which is true at that moment; once the request
	// is finished, that failure is stale and `systemctl --failed` should be clean.
	named = append(named, CoreBootContinuationUnit)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	_, _ = r.capture(ctx, "systemctl", named...)
	return named[1:]
}

func (r CoreControlRunner) observe(ctx context.Context, receipt CoreControlReceipt) (CoreControlObservation, error) {
	out := CoreControlObservation{RequestID: receipt.RequestID, CommandID: receipt.CommandID, State: "unknown"}
	raw, err := r.capture(ctx, "systemctl", "show", "--property=Id,LoadState,ActiveState,SubState,Result,MainPID,Description,Transient,Type,User,WorkingDirectory,RootDirectory,RootImage,KillMode,Restart,RemainAfterExit", receipt.Unit)
	if err != nil {
		return out, fmt.Errorf("native continuation observation unavailable")
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return out, fmt.Errorf("invalid continuation unit observation")
		}
		if _, exists := values[key]; exists {
			return out, fmt.Errorf("duplicate continuation unit property")
		}
		values[key] = value
	}
	if values["Id"] != receipt.Unit {
		return out, fmt.Errorf("continuation unit identity changed")
	}
	if values["LoadState"] == "not-found" {
		out.State = "absent"
		return out, nil
	}
	for key, expected := range map[string]string{"LoadState": "loaded", "Description": "YouEye core continuation " + receipt.Unit, "Transient": "yes", "Type": "exec", "User": "root", "KillMode": "control-group", "Restart": "no", "RemainAfterExit": "yes"} {
		if value, present := values[key]; !present || value != expected {
			return out, fmt.Errorf("continuation unit ownership changed: %s", key)
		}
	}
	if !coreRunnerRootDirectory(values) {
		return out, fmt.Errorf("continuation root directory changed")
	}
	if values["ActiveState"] == "active" && values["SubState"] == "running" && values["MainPID"] != "0" && values["MainPID"] != "" {
		out.State = "running"
	}
	if values["ActiveState"] == "active" && values["SubState"] == "exited" && values["MainPID"] == "0" && values["Result"] == "success" {
		out.State = "settled"
	}
	if values["ActiveState"] == "failed" && values["MainPID"] == "0" {
		out.State = "failed"
	}
	// Loaded, inactive and without a main process: it ended and is not unloaded yet. It is ended like an exited
	// one; told apart from nothing, Forget refused such a unit at every look.
	if values["ActiveState"] == "inactive" && values["MainPID"] == "0" {
		out.State = "settled"
	}
	return out, nil
}
