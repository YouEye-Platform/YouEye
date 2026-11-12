package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// CoreSystemdRunner owns one transient appliance service per exact action. It
// never retries a launch after durable intent. Launcher and child use separate
// records so an acknowledgement cannot overwrite a fast child's final result.
// It is not the resident process/supervisor and cannot address arbitrary units.
type CoreSystemdRunner struct {
	Root       string
	Executable string
	Capture    func(context.Context, string, ...string) ([]byte, error)
	BootID     func() (string, error)
	CgroupRoot string
}

type coreRunnerLaunch struct {
	Schema         string `json:"schema"`
	RequestID      string `json:"request_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
	Unit           string `json:"unit"`
	Executable     string `json:"executable"`
	BootID         string `json:"boot_id"`
}

type coreRunnerResult struct {
	Launch          coreRunnerLaunch      `json:"launch"`
	InvocationID    string                `json:"invocation_id"`
	PID             int                   `json:"pid"`
	ProcessIdentity string                `json:"process_identity"`
	Result          CoreActionObservation `json:"result"`
}

func (r CoreSystemdRunner) unit(j CoreJournal, s CoreStep) string {
	return fmt.Sprintf("youeye-core-%x.service", sha256.Sum256([]byte(s.RequestID+"\x00"+j.ManifestSHA256)))
}
func (r CoreSystemdRunner) path(j CoreJournal, s CoreStep) string {
	return filepath.Join(r.Root, "runners", r.unit(j, s), "launch.json")
}
func (r CoreSystemdRunner) boot() (string, error) {
	if r.BootID != nil {
		return r.BootID()
	}
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || len(strings.TrimSpace(string(raw))) != 36 {
		return "", fmt.Errorf("native boot identity unavailable")
	}
	return strings.TrimSpace(string(raw)), nil
}
func (r CoreSystemdRunner) capture(ctx context.Context, name string, args ...string) ([]byte, error) {
	if r.Capture != nil {
		return r.Capture(ctx, name, args...)
	}
	return captureCoreNative(ctx, name, args...)
}
func (r CoreSystemdRunner) expected(j CoreJournal, s CoreStep) (coreRunnerLaunch, error) {
	if !filepath.IsAbs(r.Root) || !filepath.IsAbs(r.Executable) || strings.ContainsAny(r.Executable, "\n\r$%") {
		return coreRunnerLaunch{}, fmt.Errorf("fixed absolute native runner paths required")
	}
	if err := validateNativeIdentity(j, s); err != nil {
		return coreRunnerLaunch{}, err
	}
	boot, err := r.boot()
	return coreRunnerLaunch{Schema: "youeye.core-runner.v1", RequestID: s.RequestID, ManifestSHA256: j.ManifestSHA256, Unit: r.unit(j, s), Executable: r.Executable, BootID: boot}, err
}
func (r CoreSystemdRunner) read(j CoreJournal, s CoreStep) (coreRunnerLaunch, error) {
	var launch coreRunnerLaunch
	expected, err := r.expected(j, s)
	if err != nil {
		return launch, err
	}
	raw, err := ReadCoreState(r.path(j, s), 8192)
	if err != nil {
		return launch, err
	}
	if json.Unmarshal(raw, &launch) != nil || launch.BootID == "" {
		return launch, fmt.Errorf("invalid native launch record")
	}
	expected.BootID = launch.BootID // a prior boot is retained evidence, never a new launch
	if launch != expected {
		return launch, fmt.Errorf("native runner identity changed")
	}
	return launch, nil
}
func coreRunnerDescription(unit string) string { return "YouEye core action " + unit }

func (r CoreSystemdRunner) observeUnit(ctx context.Context, launch coreRunnerLaunch) (map[string]string, error) {
	properties := "Id,LoadState,ActiveState,SubState,Result,MainPID,InvocationID,Description,Transient,KillMode,RemainAfterExit,Type,User,WorkingDirectory,RootDirectory,RootImage,ControlGroup,Restart"
	raw, err := r.capture(ctx, "systemctl", "show", "--property="+properties, launch.Unit)
	if err != nil || len(raw) > 16384 {
		return nil, fmt.Errorf("native unit observation unavailable")
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return nil, fmt.Errorf("invalid native unit observation")
		}
		if _, exists := values[key]; exists {
			return nil, fmt.Errorf("duplicate native unit property")
		}
		values[key] = value
	}
	if values["Id"] != launch.Unit {
		return nil, fmt.Errorf("native unit identity differs")
	}
	if values["LoadState"] == "not-found" {
		return values, nil
	}
	for key, expected := range map[string]string{"LoadState": "loaded", "Description": coreRunnerDescription(launch.Unit), "Transient": "yes", "KillMode": "control-group", "RemainAfterExit": "yes", "Type": "exec", "User": "root", "Restart": "no"} {
		if value, present := values[key]; !present || value != expected {
			return nil, fmt.Errorf("native action unit ownership differs: %s", key)
		}
	}
	if !coreRunnerRootDirectory(values) {
		return nil, fmt.Errorf("native action root directory differs")
	}
	return values, nil
}

// systemd normalizes WorkingDirectory=/ to an empty property. Require all
// directory properties to be present and reject chroot/image roots: only the
// system manager's default host root is equivalent to an explicit slash.
func coreRunnerRootDirectory(values map[string]string) bool {
	working, workingOK := values["WorkingDirectory"]
	root, rootOK := values["RootDirectory"]
	image, imageOK := values["RootImage"]
	return workingOK && rootOK && imageOK && (working == "" || working == "/") && root == "" && image == ""
}

func (r CoreSystemdRunner) readResult(j CoreJournal, s CoreStep, launch coreRunnerLaunch) (coreRunnerResult, error) {
	var result coreRunnerResult
	raw, err := ReadCoreState(r.path(j, s)+".result", 64<<10)
	if err != nil {
		return result, err
	}
	if json.Unmarshal(raw, &result) != nil || result.Launch != launch || len(result.InvocationID) != 32 || !isLowerHex(result.InvocationID) || result.PID <= 1 || result.ProcessIdentity == "" {
		return result, fmt.Errorf("native child result identity differs")
	}
	return result, validateNativeResult(result.Result)
}

func (r CoreSystemdRunner) Start(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	current, err := (CoreManager{Root: r.Root}).Read()
	if err != nil || current.RequestID != j.RequestID || current.ManifestSHA256 != j.ManifestSHA256 {
		return CoreActionObservation{}, fmt.Errorf("native launch must match the current coordinator")
	}
	steps := current.Steps
	if strings.HasPrefix(s.Name, "recovery-") && current.Phase == "recovering" {
		steps = current.RecoverySteps
	} else if current.Phase != "applying" {
		return CoreActionObservation{}, fmt.Errorf("native launch phase is not active")
	}
	active := false
	for _, step := range steps {
		if step.RequestID == s.RequestID && step.Name == s.Name && step.State == "started" {
			active = true
		}
	}
	if !active {
		return CoreActionObservation{}, fmt.Errorf("coordinator has not authorized native launch")
	}
	j = current
	expected, err := r.expected(j, s)
	if err != nil {
		return CoreActionObservation{}, err
	}
	unlock, err := lockCoreRunner(r.path(j, s) + ".lock")
	if err != nil {
		return CoreActionObservation{}, err
	}
	defer unlock()
	if _, err = r.read(j, s); err == nil {
		return r.Observe(ctx, j, s)
	} else if !errors.Is(err, os.ErrNotExist) {
		return CoreActionObservation{}, err
	}
	if _, err = os.Lstat(r.path(j, s) + ".result"); !errors.Is(err, os.ErrNotExist) {
		return CoreActionObservation{}, fmt.Errorf("orphaned native child evidence prevents new launch")
	}
	unit, err := r.observeUnit(ctx, expected)
	if err != nil || unit["LoadState"] != "not-found" {
		return CoreActionObservation{}, fmt.Errorf("native action unit already exists or is unobservable")
	}
	raw, _ := json.Marshal(expected)
	if err = atomicWrite(r.path(j, s), raw, 0600); err != nil {
		return CoreActionObservation{}, err
	}
	args := []string{"--quiet", "--no-ask-password", "--unit=" + expected.Unit, "--description=" + coreRunnerDescription(expected.Unit), "--service-type=exec", "--remain-after-exit", "--uid=root", "--working-directory=/", "--property=KillMode=control-group", "--property=Restart=no", "--property=TimeoutStopSec=90s", "--property=RuntimeMaxSec=2h", "--property=UMask=0077", "--property=StandardOutput=null", "--property=StandardError=null", "--", r.Executable, "update", "core", "run-action", "--request", j.RequestID, "--action", s.Name, "--manifest-sha256", j.ManifestSHA256}
	if _, err = r.capture(ctx, "systemd-run", args...); err != nil {
		return CoreActionObservation{State: "unknown", Evidence: "native launch acknowledgement unavailable"}, nil
	}
	return r.Observe(ctx, j, s)
}

// Observe never executes or restarts an action. Terminal child receipts survive
// reboot; a disappeared unit or successful systemd exit alone proves no effect.
func (r CoreSystemdRunner) Observe(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	unknown := CoreActionObservation{State: "unknown", Evidence: "native action requires retained effect reconciliation"}
	launch, err := r.read(j, s)
	if errors.Is(err, os.ErrNotExist) {
		return unknown, nil
	}
	if err != nil {
		return unknown, err
	}
	result, resultErr := r.readResult(j, s, launch)
	if resultErr != nil && !errors.Is(resultErr, os.ErrNotExist) {
		return unknown, resultErr
	}
	if resultErr == nil && (result.Result.State == "succeeded" || result.Result.State == "failed") {
		return result.Result, nil
	}
	if resultErr == nil && result.Result.State == "unknown" {
		// Sanitized terminal error/stage evidence remains useful across boots;
		// it authorizes reconciliation only, never another execution.
		return result.Result, nil
	}
	boot, err := r.boot()
	if err != nil || boot != launch.BootID {
		return unknown, err
	}
	unit, err := r.observeUnit(ctx, launch)
	if err != nil {
		return unknown, err
	}
	if unit["LoadState"] == "not-found" {
		return unknown, nil
	}
	pid, pidErr := strconv.Atoi(unit["MainPID"])
	invocation := unit["InvocationID"]
	if resultErr == nil && invocation != result.InvocationID {
		return unknown, fmt.Errorf("native unit invocation changed")
	}
	if unit["LoadState"] == "loaded" && (unit["ActiveState"] == "active" || unit["ActiveState"] == "activating") && pidErr == nil && pid > 1 && len(invocation) == 32 && isLowerHex(invocation) {
		if resultErr == nil {
			return result.Result, nil
		}
		return CoreActionObservation{State: "running", Evidence: "owned native service invocation is active"}, nil
	}
	return unknown, nil
}

func lockCoreRunner(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("native runner remains owned")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

// RunAction is called only by the fixed hidden appliance command. It binds the
// actual process to systemd's invocation, rereads the coordinator, authorizes
// current policy, and persists child intent before invoking the effect backend.
// An existing child intent is never executed again, even after a failed boot.
func (r CoreSystemdRunner) RunAction(ctx context.Context, request, name, digest string, authorize func(context.Context, CoreJournal, CoreStep) error, execute func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error)) (CoreActionObservation, error) {
	unknown := CoreActionObservation{State: "unknown", Evidence: "native action acknowledgement unavailable"}
	j, err := (CoreManager{Root: r.Root}).Read()
	if err != nil || j.RequestID != request || j.ManifestSHA256 != digest || authorize == nil || execute == nil {
		return unknown, fmt.Errorf("exact active native action required")
	}
	steps := j.Steps
	if strings.HasPrefix(name, "recovery-") && j.Phase == "recovering" {
		steps = j.RecoverySteps
	} else if j.Phase != "applying" {
		return unknown, fmt.Errorf("native action phase is not active")
	}
	var s CoreStep
	for _, step := range steps {
		if step.Name == name && step.State == "started" {
			s = step
		}
	}
	if s.Name == "" {
		return unknown, fmt.Errorf("coordinator has not started this native action")
	}
	launch, err := r.read(j, s)
	if err != nil {
		return unknown, err
	}
	boot, err := r.boot()
	if err != nil || boot != launch.BootID {
		return unknown, fmt.Errorf("native launch belongs to a different boot")
	}
	unit, err := r.observeUnit(ctx, launch)
	if err != nil || unit["MainPID"] != strconv.Itoa(os.Getpid()) || unit["InvocationID"] != os.Getenv("INVOCATION_ID") || len(unit["InvocationID"]) != 32 || !isLowerHex(unit["InvocationID"]) {
		return unknown, fmt.Errorf("native child is not the owned systemd invocation")
	}
	unlock, err := lockCoreRunner(r.path(j, s) + ".child-lock")
	if err != nil {
		return unknown, err
	}
	defer unlock()
	if result, err := r.readResult(j, s, launch); err == nil {
		if result.Result.State == "succeeded" || result.Result.State == "failed" {
			return result.Result, nil
		}
		return unknown, fmt.Errorf("native child already attempted this action; replay refused")
	} else if !errors.Is(err, os.ErrNotExist) {
		return unknown, err
	}
	if err = authorize(ctx, j, s); err != nil {
		return unknown, err
	}
	identity, err := nativeProcessIdentity(os.Getpid())
	if err != nil {
		return unknown, err
	}
	result := coreRunnerResult{Launch: launch, InvocationID: unit["InvocationID"], PID: os.Getpid(), ProcessIdentity: identity, Result: CoreActionObservation{State: "running", Stage: "execute", EffectState: "started"}}
	save := func() error {
		raw, err := json.Marshal(result)
		if err != nil {
			return err
		}
		return atomicWrite(r.path(j, s)+".result", raw, 0600)
	}
	if err = save(); err != nil {
		return unknown, err
	}
	outcome, effectErr := execute(ctx, j, s)
	if effectErr != nil || validateNativeResult(outcome) != nil {
		outcome = CoreActionObservation{State: "unknown", Stage: "execute", Code: coreNativeFailureCode(effectErr), EffectState: "started", Evidence: "native action entered effect execution; reconcile retained effect evidence before recovery"}
	}
	result.Result = outcome
	if err = save(); err != nil {
		return unknown, err
	}
	return outcome, effectErr
}

func coreNativeFailureCode(err error) string {
	switch {
	case errors.Is(err, errCoreRecoveryServices):
		return "recovery_services_unavailable"
	case errors.Is(err, errCoreRecoveryPower):
		return "recovery_power_unavailable"
	case errors.Is(err, errCoreRecoveryHealth):
		return "recovery_health_unavailable"
	case errors.Is(err, errCoreSchemaNotReady), errors.Is(err, errCoreSchemaResponseUnavailable):
		return "schema_response_unavailable"
	case errors.Is(err, errCoreSchemaRequestRejected):
		return "schema_request_rejected"
	case errors.Is(err, errCoreSchemaIdentityMismatch):
		return "schema_identity_mismatch"
	default:
		return "native_action_failed"
	}
}
