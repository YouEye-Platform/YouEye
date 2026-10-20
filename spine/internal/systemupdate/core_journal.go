package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/releasecache"
)

const CoreJournalSchema = "youeye.core-update.journal.v1"

var coreRequestPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type CoreReceipt struct {
	Machine        CoreMachineIdentity      `json:"machine"`
	Evidence       string                   `json:"evidence"`
	ManifestSHA256 string                   `json:"manifest_sha256"`
	Release        releasecache.CoreRelease `json:"release"`
	AcceptedAt     string                   `json:"accepted_at"`
}

type CoreStep struct {
	Name      string `json:"name"`
	RequestID string `json:"request_id"`
	State     string `json:"state"`
	Evidence  string `json:"evidence,omitempty"`
}

type CoreJournal struct {
	MetadataOnly        bool                     `json:"metadata_only,omitempty"`
	RecoverySteps       []CoreStep               `json:"recovery_steps,omitempty"`
	NoOp                bool                     `json:"no_op,omitempty"`
	Schema              string                   `json:"schema"`
	RequestID           string                   `json:"request_id"`
	ManifestSHA256      string                   `json:"manifest_sha256"`
	Target              releasecache.CoreRelease `json:"target"`
	Previous            CoreReceipt              `json:"previous"`
	Phase               string                   `json:"phase"`
	RestartRequired     bool                     `json:"restart_required"`
	ActivationRequested bool                     `json:"activation_requested"`
	Steps               []CoreStep               `json:"steps"`
	Error               string                   `json:"error,omitempty"`
	UpdatedAt           string                   `json:"updated_at"`
}

// CoreActionObservation must come from the action's durable owner journal.
// Unknown is not absent and can never justify repeating a migration or effect.
type CoreActionObservation struct {
	State       string // absent, running, succeeded, failed, unknown
	Evidence    string
	Stage       string `json:",omitempty"`
	Code        string `json:",omitempty"`
	EffectState string `json:",omitempty"` // not-started, started; absent means unknown
}

// CoreExecutor connects the host journal to existing host/CP/UI lifecycles.
// Authorize verifies scoped signatures, current source policy/revocation,
// compatibility and exact hardware before every advance. The activation flag
// additionally enforces freshness policy for a staged release awaiting restart.
// Start/Observe bind the stable action RequestID to exact frozen inputs. They
// must not re-resolve latest, manufacture receipt evidence or replay effects.
type CoreExecutor interface {
	Authorize(context.Context, CoreJournal, bool) error
	Start(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error)
	Observe(context.Context, CoreJournal, CoreStep) (CoreActionObservation, error)
}

type CorePreparationCanceller interface {
	CancelPreparation(context.Context, CoreJournal) error
}

type CoreManager struct {
	Root     string
	Executor CoreExecutor
	Now      func() time.Time
}

func (m CoreManager) now() string {
	if m.Now != nil {
		return m.Now().UTC().Format(time.RFC3339Nano)
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func (m CoreManager) lockCore() (func(), error) {
	if !filepath.IsAbs(m.Root) {
		return nil, fmt.Errorf("core updater requires an absolute protected state directory")
	}
	if err := os.MkdirAll(m.Root, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(m.Root, "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("core update is already running: %w", err)
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

func (m CoreManager) saveCore(j *CoreJournal) error {
	j.UpdatedAt = m.now()
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(m.Root, "journal.json"), append(raw, '\n'), 0600)
}

func (m CoreManager) Read() (CoreJournal, error) {
	return m.readCoreJournal(filepath.Join(m.Root, "journal.json"))
}

func (m CoreManager) requestPath(requestID string) string {
	return filepath.Join(m.Root, "requests", fmt.Sprintf("%x.json", sha256.Sum256([]byte(requestID))))
}

// ReadRequest preserves idempotency across later completed transactions. An
// earlier acknowledged request must never become a fresh migration attempt.
func (m CoreManager) ReadRequest(requestID string) (CoreJournal, error) {
	if !coreRequestPattern.MatchString(requestID) {
		return CoreJournal{}, fmt.Errorf("invalid core request ID")
	}
	current, err := m.Read()
	if err == nil && current.RequestID == requestID {
		return current, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return current, err
	}
	retained, err := m.readCoreJournal(m.requestPath(requestID))
	if err == nil && retained.RequestID != requestID {
		return retained, fmt.Errorf("retained core request identity differs")
	}
	return retained, err
}

func (m CoreManager) readCoreJournal(path string) (CoreJournal, error) {
	var j CoreJournal
	raw, err := ReadCoreState(path, 4<<20)
	if err != nil {
		return j, err
	}
	if err := json.Unmarshal(raw, &j); err != nil {
		return j, err
	}
	if j.Schema != CoreJournalSchema || !coreRequestPattern.MatchString(j.RequestID) || !validSHA256(j.ManifestSHA256) {
		return j, fmt.Errorf("invalid core update journal")
	}
	if err := j.Target.Validate(); err != nil {
		return j, err
	}
	if err := validateCoreSteps(j); err != nil {
		return j, err
	}
	frozen, err := ReadCoreState(filepath.Join(m.Root, "targets", j.ManifestSHA256+".json"), 1<<20)
	if err != nil {
		return j, fmt.Errorf("existing core journal has unavailable frozen input: %v", err)
	}
	target, digest, err := releasecache.ParseCoreRelease(frozen)
	if err != nil || digest != j.ManifestSHA256 || !reflect.DeepEqual(target, j.Target) {
		return j, fmt.Errorf("frozen core target differs from journal")
	}
	return j, nil
}

func coreStepNames(restart bool) []string {
	names := []string{"verify-members"}
	if restart {
		names = append(names, "stage-host")
	}
	// Capture paired state only when activation is requested, not days before
	// a staged host restart while the owner is still changing live data.
	names = append(names, "checkpoint")
	if restart {
		names = append(names, "activate-host", "host-health")
	}
	names = append(names, "apply-cp", "apply-ui", "authenticated-health")
	if restart {
		names = append(names, "commit-host")
	}
	return names
}

func coreJournalStepNames(j CoreJournal) []string {
	if j.NoOp || j.MetadataOnly {
		return []string{"verify-members", "authenticated-health"}
	}
	return coreStepNames(j.RestartRequired)
}

// A promoted assembly may change its release/source/channel identity, but not
// any signed payload, dependency or reader/schema requirement. Original member
// identities remain intact. Authority is independently rechecked at each step.
func sameCorePayloads(previous, target releasecache.CoreRelease) bool {
	return previous.Schema == target.Schema && previous.MinimumReader == target.MinimumReader &&
		reflect.DeepEqual(previous.Compatibility, target.Compatibility) && reflect.DeepEqual(previous.Members, target.Members)
}

func validateCoreSteps(j CoreJournal) error {
	names := coreJournalStepNames(j)
	if j.NoOp && (j.ManifestSHA256 != j.Previous.ManifestSHA256 || !reflect.DeepEqual(j.Target, j.Previous.Release) || j.RestartRequired) {
		return fmt.Errorf("invalid no-op core selection")
	}
	if j.MetadataOnly && (j.NoOp || j.ManifestSHA256 == j.Previous.ManifestSHA256 || j.RestartRequired || !sameCorePayloads(j.Previous.Release, j.Target)) {
		return fmt.Errorf("invalid metadata-only core selection")
	}
	if len(names) != len(j.Steps) {
		return fmt.Errorf("core journal step graph changed")
	}
	unfinished := false
	for i, step := range j.Steps {
		if step.Name != names[i] || step.RequestID != j.RequestID+"/"+names[i] {
			return fmt.Errorf("core action identity differs from frozen graph")
		}
		if unfinished && step.State != "pending" {
			return fmt.Errorf("core action advanced before its dependency")
		}
		switch step.State {
		case "succeeded":
			if step.Evidence == "" {
				return fmt.Errorf("core action lacks acceptance evidence")
			}
		case "pending", "started", "failed":
			unfinished = true
		default:
			return fmt.Errorf("unknown core action state")
		}
	}
	switch j.Phase {
	case "prepared", "applying", "needs-recovery", "cancelling", "cancelled", "recovering", "rolled-back":
	case "awaiting-restart":
		if !j.RestartRequired || j.ActivationRequested {
			return fmt.Errorf("invalid pending restart state")
		}
	case "committed":
		if unfinished {
			return fmt.Errorf("committed core has unfinished actions")
		}
	default:
		return fmt.Errorf("unknown core journal phase")
	}
	return validateCoreRecovery(j)
}

func (m CoreManager) ReadReceipt() (CoreReceipt, error) {
	var receipt CoreReceipt
	raw, err := ReadCoreState(filepath.Join(m.Root, "committed.json"), 2<<20)
	if err != nil {
		return receipt, err
	}
	if err := json.Unmarshal(raw, &receipt); err != nil {
		return receipt, err
	}
	if !validSHA256(receipt.ManifestSHA256) || receipt.AcceptedAt == "" || receipt.Evidence == "" || receipt.Machine.Validate() != nil {
		return receipt, fmt.Errorf("invalid committed core receipt")
	}
	if err := receipt.Release.Validate(); err != nil {
		return receipt, err
	}
	frozen, err := ReadCoreState(filepath.Join(m.Root, "targets", receipt.ManifestSHA256+".json"), 1<<20)
	if err != nil {
		return receipt, fmt.Errorf("existing core receipt has unavailable frozen input: %v", err)
	}
	r, digest, err := releasecache.ParseCoreRelease(frozen)
	if err != nil || digest != receipt.ManifestSHA256 || !reflect.DeepEqual(r, receipt.Release) {
		return receipt, fmt.Errorf("committed core receipt differs from retained signed selection")
	}
	return receipt, nil
}

// Prepare accepts a signature-verified manifest, then revalidates it through
// the real scoped executor. It never changes the committed release receipt.
func (m CoreManager) Prepare(ctx context.Context, requestID string, raw []byte, expectedSHA256 string) (CoreJournal, error) {
	if m.Executor == nil {
		return CoreJournal{}, fmt.Errorf("native lifecycle executor required")
	}
	unlock, err := m.lockCore()
	if err != nil {
		return CoreJournal{}, err
	}
	defer unlock()
	if !coreRequestPattern.MatchString(requestID) {
		return CoreJournal{}, fmt.Errorf("stable update request ID required")
	}
	target, digest, err := releasecache.ParseCoreRelease(raw)
	if err != nil {
		return CoreJournal{}, err
	}
	if !validSHA256(expectedSHA256) || expectedSHA256 != digest {
		return CoreJournal{}, fmt.Errorf("exact core manifest digest mismatch")
	}
	retained, retainedErr := m.ReadRequest(requestID)
	if retainedErr == nil {
		if retained.ManifestSHA256 != digest {
			return retained, fmt.Errorf("request ID is permanently bound to another manifest")
		}
		return retained, nil
	}
	if !errors.Is(retainedErr, os.ErrNotExist) {
		return retained, retainedErr
	}
	old, err := m.Read()
	if err == nil {
		if old.RequestID == requestID {
			if old.ManifestSHA256 != digest {
				return old, fmt.Errorf("request ID is bound to another manifest")
			}
			return old, nil
		}
		if old.Phase != "committed" && old.Phase != "cancelled" && old.Phase != "rolled-back" {
			return old, fmt.Errorf("another unfinished core update owns the lifecycle")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return old, err
	}
	previous, err := m.ReadReceipt()
	if err != nil {
		return CoreJournal{}, fmt.Errorf("installed core receipt required: %w", err)
	}
	if previous.ManifestSHA256 != digest && previous.Release.Source == target.Source && previous.Release.Branch == target.Branch && target.Sequence <= previous.Release.Sequence {
		return CoreJournal{}, fmt.Errorf("release sequence does not advance the installed source track")
	}
	j := CoreJournal{Schema: CoreJournalSchema, RequestID: requestID, ManifestSHA256: digest, Target: target, Previous: previous, Phase: "prepared", NoOp: previous.ManifestSHA256 == digest}
	j.MetadataOnly = !j.NoOp && sameCorePayloads(previous.Release, target)
	for _, role := range []string{"appliance", "spine", "system-root", "system-a-uki", "system-b-uki", "system-updater", "internal-recovery", "recovery-uki"} {
		var before, after releasecache.CoreMember
		for _, v := range previous.Release.Members {
			if v.Role == role {
				before = v
			}
		}
		for _, v := range target.Members {
			if v.Role == role {
				after = v
			}
		}
		if before.Artifact.SHA256 != after.Artifact.SHA256 {
			j.RestartRequired = true
		}
	}
	for _, name := range coreJournalStepNames(j) {
		j.Steps = append(j.Steps, CoreStep{Name: name, RequestID: requestID + "/" + name, State: "pending"})
	}
	if err := m.Executor.Authorize(ctx, j, false); err != nil {
		return j, err
	}
	if err := atomicWrite(filepath.Join(m.Root, "targets", digest+".json"), raw, 0600); err != nil {
		return j, err
	}
	if err := m.retainSequence(previous.Release, previous.ManifestSHA256, false); err != nil {
		return j, err
	}
	if err := m.retainSequence(target, digest, !j.NoOp); err != nil {
		return j, err
	}
	if old.RequestID != "" {
		retainedRaw, err := json.Marshal(old)
		if err != nil {
			return j, err
		}
		if err = atomicWrite(m.requestPath(old.RequestID), append(retainedRaw, '\n'), 0600); err != nil {
			return j, err
		}
	}
	return j, m.saveCore(&j)
}

// Advance reconciles each uncertain effect before considering a retry. A
// positively absent action may start; running or unknown actions remain pending.
// Host staging returns awaiting-restart without retaining any builder resource.
func (m CoreManager) Advance(ctx context.Context, requestID string, activate bool) (CoreJournal, error) {
	if m.Executor == nil {
		return CoreJournal{}, fmt.Errorf("native lifecycle executor required")
	}
	unlock, err := m.lockCore()
	if err != nil {
		return CoreJournal{}, err
	}
	defer unlock()
	j, err := m.Read()
	if err != nil {
		return j, err
	}
	if j.RequestID != requestID {
		return j, fmt.Errorf("exact core update request ID required")
	}
	if j.Phase == "committed" || j.Phase == "cancelled" {
		return j, nil
	}
	if j.Phase == "cancelling" {
		return j, fmt.Errorf("preparation cancellation owns this request")
	}
	if len(j.RecoverySteps) > 0 {
		return j, fmt.Errorf("core recovery owns this request; its original apply graph cannot resume")
	}
	if err := m.Executor.Authorize(ctx, j, activate || j.ActivationRequested); err != nil {
		return j, err
	}
	if activate {
		j.ActivationRequested = true
	}
	if j.Phase == "needs-recovery" {
		j.Phase = "applying"
		if err = m.saveCore(&j); err != nil {
			return j, err
		}
	}
	for i := range j.Steps {
		step := &j.Steps[i]
		if step.State == "succeeded" {
			continue
		}
		if j.RestartRequired && (step.Name == "checkpoint" || step.Name == "activate-host") && !j.ActivationRequested {
			j.Phase = "awaiting-restart"
			return j, m.saveCore(&j)
		}
		if err := ctx.Err(); err != nil {
			return j, err
		}
		observation := CoreActionObservation{State: "absent"}
		if step.State != "pending" {
			observation, err = m.Executor.Observe(ctx, j, *step)
			if err != nil {
				return j, err
			}
		}
		// Once the coordinator recorded start intent, missing subordinate
		// evidence is unknown. It cannot authorize a second migration/effect.
		if observation.State == "absent" && step.State != "pending" {
			observation = CoreActionObservation{State: "unknown", Evidence: "started action has no retained receipt"}
		}
		if observation.State == "absent" || observation.State == "retryable" {
			if step.State == "failed" {
				return j, fmt.Errorf("failed action requires explicit recovery, not a new attempt")
			}
			if err := m.Executor.Authorize(ctx, j, j.ActivationRequested); err != nil {
				return j, err
			}
			step.State = "started"
			j.Phase = "applying"
			j.Error = ""
			if err := m.saveCore(&j); err != nil {
				return j, err
			}
			observation, err = m.Executor.Start(ctx, j, *step)
			if err != nil {
				j.Error = "Action acknowledgement unavailable; reconcile the same recorded request"
				_ = m.saveCore(&j)
				return j, err
			}
		}
		switch observation.State {
		case "succeeded":
			if observation.Evidence == "" {
				return j, fmt.Errorf("%s completed without acceptance evidence", step.Name)
			}
			step.State = "succeeded"
			step.Evidence = observation.Evidence
			if err := m.saveCore(&j); err != nil {
				return j, err
			}
		case "failed":
			step.State = "failed"
			step.Evidence = observation.Evidence
			j.Phase = "needs-recovery"
			j.Error = "Recorded lifecycle action failed; retain paired checkpoint and prior release"
			return j, m.saveCore(&j)
		case "running", "unknown", "retryable":
			step.Evidence = observation.Evidence
			if observation.State == "retryable" {
				j.Error = "Lifecycle admission ended before checkpoint effects; settle ordinary work and resume this request"
				if observation.Code == "admission_rejected" {
					j.Error = "Lifecycle admission is blocked before checkpoint effects; reconcile unfinished app, container or backup work and current policy, then resume this request"
				}
			}
			j.Phase = "applying"
			return j, m.saveCore(&j)
		default:
			return j, fmt.Errorf("unsupported action observation %q", observation.State)
		}
	}
	if err := m.Executor.Authorize(ctx, j, j.ActivationRequested); err != nil {
		return j, err
	}
	// Detect a lost commit acknowledgement by reading the protected receipt.
	current, err := m.ReadReceipt()
	if err != nil {
		return j, err
	}
	if current.ManifestSHA256 != j.Previous.ManifestSHA256 && current.ManifestSHA256 != j.ManifestSHA256 {
		return j, fmt.Errorf("committed release changed outside this transaction")
	}
	if current.ManifestSHA256 == j.ManifestSHA256 && !reflect.DeepEqual(current.Release, j.Target) {
		return j, fmt.Errorf("committed manifest identity differs")
	}
	if current.ManifestSHA256 != j.ManifestSHA256 {
		receipt := CoreReceipt{ManifestSHA256: j.ManifestSHA256, Release: j.Target, AcceptedAt: m.now(), Machine: j.Previous.Machine, Evidence: "core-request:" + j.RequestID}
		raw, err := json.Marshal(receipt)
		if err != nil {
			return j, err
		}
		if err := atomicWrite(filepath.Join(m.Root, "committed.json"), append(raw, '\n'), 0600); err != nil {
			return j, err
		}
	}
	j.Phase = "committed"
	j.Error = ""
	return j, m.saveCore(&j)
}

// Cancel is permitted only before an effectful checkpoint/lifecycle step.
// Once effects exist, explicit recovery must reconcile their actual outcomes.
func (m CoreManager) Cancel(ctx context.Context, requestID string) (CoreJournal, error) {
	unlock, err := m.lockCore()
	if err != nil {
		return CoreJournal{}, err
	}
	defer unlock()
	j, err := m.Read()
	if err != nil {
		return j, err
	}
	if j.RequestID != requestID {
		return j, fmt.Errorf("exact core request required")
	}
	if j.Phase == "cancelled" {
		return j, nil
	}
	if j.Phase == "committed" || j.Phase == "rolled-back" || len(j.RecoverySteps) > 0 {
		return j, fmt.Errorf("completed or recovering core request cannot be cancelled")
	}
	if j.ActivationRequested {
		return j, fmt.Errorf("activation was requested; reconcile its lifecycle")
	}
	hasEffects := false
	for _, step := range j.Steps {
		if step.State == "pending" {
			continue
		}
		if step.Name != "verify-members" && step.Name != "stage-host" {
			return j, fmt.Errorf("core update requires lifecycle recovery before cancellation")
		}
		hasEffects = true
	}
	if hasEffects {
		canceller, ok := m.Executor.(CorePreparationCanceller)
		if !ok {
			return j, fmt.Errorf("native preparation cancellation required")
		}
		// Publish exclusive cancellation intent before stopping any owned child.
		// A lost response can retry cleanup but cannot resume the apply graph.
		j.Phase = "cancelling"
		if err = m.saveCore(&j); err != nil {
			return j, err
		}
		if err = canceller.CancelPreparation(ctx, j); err != nil {
			return j, err
		}
	}
	j.Phase = "cancelled"
	return j, m.saveCore(&j)
}
