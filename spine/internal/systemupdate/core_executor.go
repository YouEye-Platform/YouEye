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

// NativeCoreExecutor records intent before invoking a native operation. A lost
// process or acknowledgement leaves an uncertain action, never a fresh retry.
// Reconcile may return terminal evidence only from the operation's own durable
// journal or an exact target observation; absence of a process proves neither.
type NativeCoreExecutor struct {
	Root                         string
	AuthorizeAction              func(context.Context, CoreJournal, bool) error
	AuthorizeRecoveryAction      func(context.Context, CoreJournal) error
	AuthorizeLiveFenceAction     func(context.Context, CoreJournal, CoreStep) error
	ContinueRecoveryHealthAction func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error)
	CancelPreparationAction      func(context.Context, CoreJournal) error
	AdmitAction                  func(context.Context, CoreJournal, CoreStep) error
	ExecuteAction                func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error)
	ReconcileAction              func(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error)
}

// ActionStatus reads sanitized retained diagnostics without launching work or
// requiring the action lock (which may be held by a bounded admission wait).
func (e NativeCoreExecutor) ActionStatus(j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	a, err := e.read(j, s)
	if err != nil {
		return CoreActionObservation{}, err
	}
	out := a.Result
	if a.Active && out.State == "running" {
		identity, err := nativeProcessIdentity(a.PID)
		if err != nil || identity != a.ProcessIdentity {
			out.State, out.EffectState = "unknown", ""
		}
	}
	out.Evidence = "" // arbitrary subordinate evidence is not a status message
	return out, nil
}

func (e NativeCoreExecutor) CancelPreparation(ctx context.Context, j CoreJournal) error {
	if e.CancelPreparationAction == nil {
		return fmt.Errorf("native staged host cancellation is not configured")
	}
	return e.CancelPreparationAction(ctx, j)
}

func (e NativeCoreExecutor) AuthorizeLiveFence(ctx context.Context, j CoreJournal, s CoreStep) error {
	if e.AuthorizeLiveFenceAction == nil {
		return fmt.Errorf("live native action has no owned recovery fence")
	}
	return e.AuthorizeLiveFenceAction(ctx, j, s)
}

type nativeCoreAction struct {
	Schema          string                `json:"schema"`
	RequestID       string                `json:"request_id"`
	ManifestSHA256  string                `json:"manifest_sha256"`
	Name            string                `json:"name"`
	PID             int                   `json:"pid"`
	ProcessIdentity string                `json:"process_identity"`
	Active          bool                  `json:"active"`
	Result          CoreActionObservation `json:"result"`
}

func nativeProcessIdentity(pid int) (string, error) {
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	// comm may contain spaces and parentheses; fields after its last ')' begin
	// at field 3. Include start time so PID recycling cannot claim ownership.
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return "", fmt.Errorf("invalid native process identity")
	}
	fields := strings.Fields(string(raw[end+1:]))
	if len(fields) < 20 || fields[0] == "Z" {
		return "", fmt.Errorf("native process is not live")
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return "", err
	}
	return strings.TrimSpace(string(boot)) + ":" + fields[19], nil
}

func (e NativeCoreExecutor) actionPath(s CoreStep) string {
	return filepath.Join(e.Root, "actions", fmt.Sprintf("%x.json", sha256.Sum256([]byte(s.RequestID))))
}

func (e NativeCoreExecutor) Authorize(ctx context.Context, j CoreJournal, activation bool) error {
	if e.Root == "" || e.AuthorizeAction == nil || e.ExecuteAction == nil || e.ReconcileAction == nil {
		return fmt.Errorf("native core lifecycle is not configured")
	}
	return e.AuthorizeAction(ctx, j, activation)
}

func (e NativeCoreExecutor) AuthorizeRecovery(ctx context.Context, j CoreJournal) error {
	if e.AuthorizeRecoveryAction == nil || e.ExecuteAction == nil || e.ReconcileAction == nil || !filepath.IsAbs(e.Root) {
		return fmt.Errorf("native paired recovery is not configured")
	}
	return e.AuthorizeRecoveryAction(ctx, j)
}

func (e NativeCoreExecutor) read(j CoreJournal, s CoreStep) (nativeCoreAction, error) {
	var a nativeCoreAction
	raw, err := ReadCoreState(e.actionPath(s), 64<<10)
	if err != nil {
		return a, err
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return a, err
	}
	if a.Schema != "youeye.core-action.v1" || a.RequestID != s.RequestID || a.Name != s.Name || a.ManifestSHA256 != j.ManifestSHA256 || a.PID <= 0 || a.ProcessIdentity == "" {
		return a, fmt.Errorf("native action identity differs from core transaction")
	}
	if err := validateNativeResult(a.Result); err != nil {
		return a, err
	}
	return a, nil
}

func validateNativeResult(result CoreActionObservation) error {
	if result.Stage != "" && result.Stage != "admission" && result.Stage != "launch" && result.Stage != "execute" {
		return fmt.Errorf("invalid native action stage")
	}
	if result.EffectState != "" && result.EffectState != "not-started" && result.EffectState != "started" {
		return fmt.Errorf("invalid native effect state")
	}
	switch result.Code {
	case "", "admission_timeout", "admission_cancelled", "admission_rejected", "native_action_failed", "schema_response_unavailable", "schema_request_rejected", "schema_identity_mismatch", "recovery_services_unavailable", "recovery_power_unavailable", "recovery_health_unavailable":
	default:
		return fmt.Errorf("invalid native action error code")
	}
	switch result.State {
	case "running", "unknown":
	case "retryable":
		if result.Stage != "admission" || result.EffectState != "not-started" || (result.Code != "admission_timeout" && result.Code != "admission_cancelled" && result.Code != "admission_rejected") || result.Evidence == "" {
			return fmt.Errorf("retry requires positive pre-effect admission evidence")
		}
	case "succeeded", "failed":
		if result.Evidence == "" {
			return fmt.Errorf("native action has no terminal evidence")
		}
	default:
		return fmt.Errorf("invalid durable native action state")
	}
	if len(result.Evidence) > 32768 {
		return fmt.Errorf("native action evidence is oversized")
	}
	return nil
}

func (e NativeCoreExecutor) save(s CoreStep, a nativeCoreAction) error {
	if err := validateNativeResult(a.Result); err != nil {
		return err
	}
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return atomicWrite(e.actionPath(s), raw, 0600)
}

func (e NativeCoreExecutor) lockAction(s CoreStep) (func(), error) {
	if !filepath.IsAbs(e.Root) || s.RequestID == "" {
		return nil, fmt.Errorf("protected native action root and exact request required")
	}
	path := e.actionPath(s) + ".lock"
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("native action is owned by another executor: %w", err)
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

func validateNativeIdentity(j CoreJournal, s CoreStep) error {
	if !validSHA256(j.ManifestSHA256) || !coreRequestPattern.MatchString(j.RequestID) || s.RequestID != j.RequestID+"/"+s.Name {
		return fmt.Errorf("native action lacks exact transaction identity")
	}
	for _, name := range coreStepNames(true) {
		if name == s.Name {
			return nil
		}
	}
	for _, s2 := range j.RecoverySteps {
		if s.Name == s2.Name && s.RequestID == s2.RequestID && (j.Phase == "recovering" || j.Phase == "needs-recovery") {
			return validateCoreRecovery(j)
		}
	}
	return fmt.Errorf("unknown native core action")
}

func (e NativeCoreExecutor) Start(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	if err := validateNativeIdentity(j, s); err != nil {
		return CoreActionObservation{}, err
	}
	unlock, err := e.lockAction(s)
	if err != nil {
		return CoreActionObservation{}, err
	}
	defer unlock()
	if previous, err := e.read(j, s); err == nil {
		if previous.Result.State != "retryable" || e.AdmitAction == nil || (s.Name != "checkpoint" && s.Name != "recovery-fence") {
			return e.observe(ctx, j, s)
		}
		// Only this executor's positive pre-launch receipt permits admission
		// again. Unknown/missing child evidence never enters this branch.
	} else if !errors.Is(err, os.ErrNotExist) {
		return CoreActionObservation{}, err
	}
	var authorizationErr error
	if strings.HasPrefix(s.Name, "recovery-") {
		authorizationErr = e.AuthorizeRecovery(ctx, j)
	} else {
		authorizationErr = e.Authorize(ctx, j, j.ActivationRequested)
	}
	if authorizationErr != nil {
		return CoreActionObservation{}, authorizationErr
	}
	identity, err := nativeProcessIdentity(os.Getpid())
	if err != nil {
		return CoreActionObservation{}, err
	}
	a := nativeCoreAction{Schema: "youeye.core-action.v1", RequestID: s.RequestID, Name: s.Name, ManifestSHA256: j.ManifestSHA256, PID: os.Getpid(), ProcessIdentity: identity, Active: true, Result: CoreActionObservation{State: "running"}}
	if e.AdmitAction != nil && (s.Name == "checkpoint" || s.Name == "recovery-fence") {
		a.Result = CoreActionObservation{State: "running", Stage: "admission", EffectState: "not-started", Evidence: "waiting for ordinary lifecycle work to settle"}
		if err := e.save(s, a); err != nil {
			return a.Result, err
		}
		if err := e.AdmitAction(ctx, j, s); err != nil {
			a.Active = false
			a.Result.State, a.Result.Code = "retryable", "admission_rejected"
			a.Result.Evidence = "lifecycle admission rejected before native action launch; reconcile ordinary work and current policy"
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				a.Result.State, a.Result.Code = "retryable", "admission_timeout"
				if errors.Is(err, context.Canceled) {
					a.Result.Code = "admission_cancelled"
				}
				a.Result.Evidence = "lifecycle admission ended before native action launch; resume the same request after ordinary work settles"
			}
			if saveErr := e.save(s, a); saveErr != nil {
				return CoreActionObservation{State: "unknown"}, saveErr
			}
			return a.Result, nil
		}
	}
	a.Result = CoreActionObservation{State: "running", Stage: "launch"}
	if err := e.save(s, a); err != nil {
		return CoreActionObservation{}, err
	}
	result, executionErr := e.ExecuteAction(ctx, j, s)
	a.Active = false
	if executionErr != nil {
		// Do not guess whether a command returning an error committed its effect.
		// Record uncertainty without persisting subprocess output or secrets.
		a.Result = CoreActionObservation{State: "unknown", Evidence: "native operation acknowledgement unavailable"}
		if saveErr := e.save(s, a); saveErr != nil {
			return a.Result, saveErr
		}
		return a.Result, executionErr
	}
	if err := validateNativeResult(result); err != nil {
		return CoreActionObservation{}, err
	}
	a.Result = result
	if err := e.save(s, a); err != nil {
		return result, err
	}
	return result, nil
}

func (e NativeCoreExecutor) Observe(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	if err := validateNativeIdentity(j, s); err != nil {
		return CoreActionObservation{}, err
	}
	unlock, err := e.lockAction(s)
	if err != nil {
		return CoreActionObservation{}, err
	}
	defer unlock()
	return e.observe(ctx, j, s)
}

func (e NativeCoreExecutor) observe(ctx context.Context, j CoreJournal, s CoreStep) (CoreActionObservation, error) {
	a, err := e.read(j, s)
	if errors.Is(err, os.ErrNotExist) {
		if s.State != "pending" && s.State != "" {
			return CoreActionObservation{State: "unknown", Evidence: "started native action has no retained receipt"}, nil
		}
		return CoreActionObservation{State: "absent"}, nil
	}
	if err != nil {
		return CoreActionObservation{}, err
	}
	if a.Result.State == "succeeded" || a.Result.State == "failed" || a.Result.State == "retryable" {
		return a.Result, nil
	}
	if a.Active && a.Result.State == "running" {
		identity, err := nativeProcessIdentity(a.PID)
		if err == nil && identity == a.ProcessIdentity {
			return a.Result, nil
		}
	}
	result, err := e.ReconcileAction(ctx, j, s)
	if err != nil {
		return CoreActionObservation{}, err
	}
	// A started effect cannot become absent: even an absent child/process may
	// have completed a migration or write before losing its receipt.
	if result.State == "absent" {
		result = CoreActionObservation{State: "unknown", Evidence: "started operation has no conclusive retained receipt"}
	}
	if err := validateNativeResult(result); err != nil {
		return CoreActionObservation{}, err
	}
	a.Result = result
	if err := e.save(s, a); err != nil {
		return CoreActionObservation{}, err
	}
	return result, nil
}
