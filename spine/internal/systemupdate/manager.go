package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"github.com/youeye-platform/YouEye/releasecache"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const (
	JournalSchema = "youeye.system-update.journal.v1"
	StatusSchema  = "youeye.system-update.v1"

	PhaseHealthy   = "healthy"
	PhaseAvailable = "available"
	PhaseDownload  = "downloading"
	PhaseWriting   = "writing"
	PhaseStaged    = "staged"
	PhasePending   = "pending-reboot"
	PhaseTrial     = "trial"
	PhaseFailed    = "failed"
	PhaseRollback  = "rolled-back"

	maxManifestBytes    = int64(1024 * 1024)
	maxSignatureBytes   = int64(4096)
	updateHeadroomBytes = uint64(512 * 1024 * 1024)
)

type Journal struct {
	Schema              string           `json:"schema"`
	TransactionID       string           `json:"transaction_id"`
	ManifestSHA256      string           `json:"manifest_sha256"`
	CurrentImage        string           `json:"current_image"`
	TargetImage         string           `json:"target_image"`
	ActiveSlot          string           `json:"active_slot"`
	CandidateSlot       string           `json:"candidate_slot"`
	Phase               string           `json:"phase"`
	DownloadedBytes     map[string]int64 `json:"downloaded_bytes,omitempty"`
	TrialFailures       int              `json:"trial_failures,omitempty"`
	ErrorCode           string           `json:"error_code,omitempty"`
	Error               string           `json:"error,omitempty"`
	Channel             string           `json:"channel,omitempty"`
	ReleaseTag          string           `json:"release_tag,omitempty"`
	ReleaseNotes        string           `json:"release_notes,omitempty"`
	RequiredCacheBytes  uint64           `json:"required_cache_bytes,omitempty"`
	AvailableCacheBytes uint64           `json:"available_cache_bytes,omitempty"`
	StartedAt           string           `json:"started_at"`
	UpdatedAt           string           `json:"updated_at"`
}

type Status struct {
	Schema              string           `json:"schema"`
	State               string           `json:"state"`
	CurrentImage        string           `json:"current_image"`
	RunningImage        string           `json:"running_image"`
	TargetImage         string           `json:"target_image,omitempty"`
	ActiveSlot          string           `json:"active_slot"`
	CandidateSlot       string           `json:"candidate_slot,omitempty"`
	PreviousSlot        string           `json:"previous_slot,omitempty"`
	TransactionID       string           `json:"transaction_id,omitempty"`
	ManifestSHA256      string           `json:"manifest_sha256,omitempty"`
	DownloadedBytes     map[string]int64 `json:"downloaded_bytes,omitempty"`
	TrialFailures       int              `json:"trial_failures,omitempty"`
	BootAttempts        int              `json:"boot_attempts,omitempty"`
	RebootRequired      bool             `json:"reboot_required"`
	RolledBack          bool             `json:"rolled_back"`
	ErrorCode           string           `json:"error_code,omitempty"`
	Error               string           `json:"error,omitempty"`
	Channel             string           `json:"channel,omitempty"`
	ReleaseTag          string           `json:"release_tag,omitempty"`
	ReleaseNotes        string           `json:"release_notes,omitempty"`
	RequiredCacheBytes  uint64           `json:"required_cache_bytes,omitempty"`
	AvailableCacheBytes uint64           `json:"available_cache_bytes,omitempty"`
	UpdatedAt           string           `json:"updated_at,omitempty"`
}

type SourceOptions struct {
	ManifestSource         string
	SignatureSource        string
	AllowTest              bool
	ReplaceFailed          bool
	Bootstrap              bool
	ExpectedManifestSHA256 string
	Channel                string
	ReleaseTag             string
	ReleaseNotes           string
	ExpectedReleaseBranch  string
	AllowCurrent           bool
	discoveryOnly          bool
}

type ReconcileOptions struct {
	HealthFailed bool
}

type ReconcileResult struct {
	Status         Status `json:"status"`
	RebootRequired bool   `json:"reboot_required"`
}

type Config struct {
	CurrentManifestPath string
	StatePath           string
	JournalPath         string
	HealthyManifestPath string
	ConvergencePath     string
	CacheDir            string
	TrustKeyPath        string
	KernelCmdlinePath   string
	ESPMountpoint       string
	HTTPClient          *http.Client
	Now                 func() time.Time
	DiscoverLayout      func(activeSlot string) (Layout, error)
	Run                 func(context.Context, string, ...string) ([]byte, error)
	WriteRoot           func(context.Context, string, Artifact, string) error
	VerifyTarget        func(context.Context, string, Manifest) error
	VerifyStagedRoot    func(context.Context, string, Artifact) error
	VerifyBootAssets    func(context.Context, Layout, Manifest) error
	InstallBootAssets   func(context.Context, Layout, Manifest, string, string, string) error
	CreateBootEntry     func(Layout, Manifest) error
	RemoveBootEntries   func(Layout) error
	ExecutablePath      func() (string, error)
	AvailableBytes      func(string) (uint64, error)
}

type Manager struct{ config Config }

func DefaultConfig() Config {
	return Config{
		CurrentManifestPath: appliance.ManifestPath,
		StatePath:           appliance.StatePath,
		JournalPath:         appliance.StateMountpoint + "/system-update/journal.json",
		HealthyManifestPath: appliance.StateMountpoint + "/system-update/healthy-manifest.json",
		ConvergencePath:     appliance.StateMountpoint + "/first-deploy/convergence-intent.json",
		CacheDir:            appliance.DataMountpoint + "/system-update",
		TrustKeyPath:        "/usr/share/youeye/appliance-development.pub",
		KernelCmdlinePath:   "/proc/cmdline",
		ESPMountpoint:       "/efi",
		HTTPClient: &http.Client{
			Transport: releasecache.Wrap(nil),
			Timeout:   0,
			CheckRedirect: func(request *http.Request, via []*http.Request) error {
				return validateSystemUpdateRedirect(request, via)
			},
		},
		Now:            time.Now,
		DiscoverLayout: DiscoverLayout,
		Run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).CombinedOutput()
		},
		ExecutablePath: os.Executable,
		AvailableBytes: filesystemAvailableBytes,
	}
}

func validateSystemUpdateRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("too many system update redirects")
	}
	if len(via) == 0 {
		return validateRemoteURL(request.URL)
	}
	origin := via[0].URL
	if err := validateSystemUpdateDownloadURL(request.URL, origin); err != nil {
		return err
	}

	if strings.EqualFold(origin.Hostname(), "github.com") {
		switch strings.ToLower(request.URL.Hostname()) {
		case "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com":
			return nil
		default:
			return fmt.Errorf("GitHub system update redirected to untrusted host %q", request.URL.Hostname())
		}
	}
	if !strings.EqualFold(request.URL.Host, origin.Host) {
		return errors.New("system update redirected across origins")
	}
	return nil
}

func New(config Config) *Manager {
	defaults := DefaultConfig()
	if config.CurrentManifestPath == "" {
		config.CurrentManifestPath = defaults.CurrentManifestPath
	}
	if config.StatePath == "" {
		config.StatePath = defaults.StatePath
	}
	if config.JournalPath == "" {
		config.JournalPath = defaults.JournalPath
	}
	if config.HealthyManifestPath == "" {
		config.HealthyManifestPath = defaults.HealthyManifestPath
	}
	if config.ConvergencePath == "" {
		config.ConvergencePath = defaults.ConvergencePath
	}
	if config.CacheDir == "" {
		config.CacheDir = defaults.CacheDir
	}
	if config.TrustKeyPath == "" {
		config.TrustKeyPath = defaults.TrustKeyPath
	}
	if config.KernelCmdlinePath == "" {
		config.KernelCmdlinePath = defaults.KernelCmdlinePath
	}
	if config.ESPMountpoint == "" {
		config.ESPMountpoint = defaults.ESPMountpoint
	}
	if config.HTTPClient == nil {
		config.HTTPClient = defaults.HTTPClient
	}
	if config.Now == nil {
		config.Now = defaults.Now
	}
	if config.DiscoverLayout == nil {
		config.DiscoverLayout = defaults.DiscoverLayout
	}
	if config.Run == nil {
		config.Run = defaults.Run
	}
	if config.ExecutablePath == nil {
		config.ExecutablePath = defaults.ExecutablePath
	}
	if config.AvailableBytes == nil {
		config.AvailableBytes = defaults.AvailableBytes
	}
	return &Manager{config: config}
}

func NewDefault() *Manager { return New(DefaultConfig()) }

func (m *Manager) Status() (Status, error) {
	current, state, runningSlot, err := m.current()
	if err != nil {
		return Status{}, err
	}
	status := Status{
		Schema: StatusSchema, State: PhaseHealthy,
		CurrentImage: state.Slots.CurrentImageVersion,
		RunningImage: current.ImageVersion,
		ActiveSlot:   runningSlot, PreviousSlot: state.Slots.Previous,
	}
	journal, err := loadJournal(m.config.JournalPath)
	if errors.Is(err, os.ErrNotExist) {
		return status, nil
	}
	if err != nil {
		return Status{}, err
	}
	status.State = journal.Phase
	status.TargetImage = journal.TargetImage
	status.CandidateSlot = journal.CandidateSlot
	status.TransactionID = journal.TransactionID
	status.ManifestSHA256 = journal.ManifestSHA256
	status.DownloadedBytes = cloneBytes(journal.DownloadedBytes)
	status.TrialFailures = journal.TrialFailures
	status.BootAttempts = BootAttempts
	status.RebootRequired = journal.Phase == PhasePending
	status.RolledBack = journal.Phase == PhaseRollback
	status.ErrorCode = journal.ErrorCode
	status.Error = journal.Error
	status.Channel = journal.Channel
	status.ReleaseTag = journal.ReleaseTag
	status.ReleaseNotes = journal.ReleaseNotes
	status.RequiredCacheBytes = journal.RequiredCacheBytes
	status.AvailableCacheBytes = journal.AvailableCacheBytes
	status.UpdatedAt = journal.UpdatedAt
	return status, nil
}

func (m *Manager) Discover(ctx context.Context, options SourceOptions) (Status, error) {
	unlock, err := m.lock()
	if err != nil {
		return Status{}, err
	}
	defer unlock()
	// Discovery may observe the exact installed release without treating it as
	// an upgrade. Stage retains its stricter ordering guard.
	options.AllowCurrent = true
	options.discoveryOnly = true
	_, _, _, _, err = m.resolve(ctx, options)
	if err != nil {
		return Status{}, err
	}
	return m.Status()
}

func (m *Manager) Stage(ctx context.Context, options SourceOptions) (status Status, returnedErr error) {
	unlock, err := m.lock()
	if err != nil {
		return Status{}, err
	}
	defer unlock()

	verified, layout, state, journal, err := m.resolve(ctx, options)
	if err != nil {
		return Status{}, err
	}
	if journal.Phase == PhaseStaged || journal.Phase == PhasePending || journal.Phase == PhaseTrial {
		return m.Status()
	}
	if state.Slots.CurrentImageVersion == journal.TargetImage {
		journal.Phase = PhaseHealthy
		journal.ErrorCode = ""
		journal.Error = ""
		journal.UpdatedAt = m.now()
		if err := writeJournal(m.config.JournalPath, journal); err != nil {
			return Status{}, err
		}
		return m.Status()
	}
	required, err := requiredArtifactBytes(verified.Manifest, m.transactionDir(journal.TransactionID))
	if err != nil {
		return Status{}, err
	}
	available, err := m.config.AvailableBytes(m.config.CacheDir)
	if err != nil {
		return Status{}, fmt.Errorf("measure system update cache capacity: %w", err)
	}
	if required > ^uint64(0)-updateHeadroomBytes || available < required+updateHeadroomBytes {
		return Status{}, fmt.Errorf("insufficient YE-DATA capacity for system update: need %d bytes plus %d bytes headroom, have %d bytes", required, updateHeadroomBytes, available)
	}
	journal.RequiredCacheBytes = required
	journal.AvailableCacheBytes = available
	defer func() {
		if returnedErr == nil {
			return
		}
		journal.Phase = PhaseFailed
		journal.ErrorCode = classifyError(returnedErr)
		journal.Error = boundedError(returnedErr)
		journal.UpdatedAt = m.now()
		_ = writeJournal(m.config.JournalPath, journal)
		latest, loadErr := appliance.LoadState(m.config.StatePath)
		if loadErr == nil && latest.Transaction.ID == journal.TransactionID {
			latest.Transaction.Stage = PhaseFailed
			_ = appliance.WriteStateAtomic(m.config.StatePath, latest)
		}
	}()

	journal.Phase = PhaseDownload
	journal.ErrorCode = ""
	journal.Error = ""
	journal.UpdatedAt = m.now()
	if journal.DownloadedBytes == nil {
		journal.DownloadedBytes = map[string]int64{}
	}
	if err := writeJournal(m.config.JournalPath, journal); err != nil {
		return Status{}, err
	}

	transactionDir := m.transactionDir(journal.TransactionID)
	artifactPaths := map[string]string{}
	for _, artifact := range verified.Manifest.Artifacts {
		destination := filepath.Join(transactionDir, filepath.Base(artifact.Path))
		source, err := resolveArtifactSource(options.ManifestSource, artifact.Path)
		if err != nil {
			return Status{}, err
		}
		if err := m.downloadSource(ctx, source, destination+".part", destination, artifact.SizeBytes, artifact.SHA256); err != nil {
			if info, statErr := os.Stat(destination + ".part"); statErr == nil {
				journal.DownloadedBytes[artifact.Role] = info.Size()
			}
			return Status{}, fmt.Errorf("download %s: %w", artifact.Role, err)
		}
		journal.DownloadedBytes[artifact.Role] = artifact.SizeBytes
		journal.UpdatedAt = m.now()
		if err := writeJournal(m.config.JournalPath, journal); err != nil {
			return Status{}, err
		}
		artifactPaths[artifact.Role] = destination
	}

	journal.Phase = PhaseWriting
	journal.UpdatedAt = m.now()
	if err := writeJournal(m.config.JournalPath, journal); err != nil {
		return Status{}, err
	}
	state.Slots.Candidate = layout.InactiveSlot
	state.Slots.CandidateImageVersion = verified.Manifest.TargetImageVersion
	state.Transaction = appliance.TransactionState{
		ID: journal.TransactionID, Stage: PhaseWriting,
		TargetImageVersion: verified.Manifest.TargetImageVersion,
	}
	if !options.Bootstrap {
		state.Transaction.ManifestSHA256 = verified.SHA256
		state.Transaction.ActiveSlot = layout.ActiveSlot
	}
	if err := appliance.WriteStateAtomic(m.config.StatePath, state); err != nil {
		return Status{}, err
	}

	rootArtifact, _ := verified.Manifest.Artifact("system-root")
	if err := m.callWriteRoot(ctx, artifactPaths["system-root"], rootArtifact, layout.InactiveDevice); err != nil {
		return Status{}, err
	}
	if err := m.callVerifyTarget(ctx, layout.InactiveDevice, verified.Manifest); err != nil {
		return Status{}, err
	}
	ukiRole := "system-" + strings.ToLower(layout.InactiveSlot) + "-uki"
	manifestPath := filepath.Join(transactionDir, "system-update-manifest.json")
	signaturePath := manifestPath + ".sig"
	if err := m.callInstallBootAssets(ctx, layout, verified.Manifest, artifactPaths[ukiRole], manifestPath, signaturePath); err != nil {
		return Status{}, err
	}

	state.Transaction.Stage = PhaseStaged
	if err := appliance.WriteStateAtomic(m.config.StatePath, state); err != nil {
		return Status{}, err
	}
	journal.Phase = PhaseStaged
	journal.ErrorCode = ""
	journal.Error = ""
	journal.UpdatedAt = m.now()
	if err := writeJournal(m.config.JournalPath, journal); err != nil {
		return Status{}, err
	}
	return m.Status()
}

func (m *Manager) Activate(ctx context.Context, reboot bool) (Status, error) {
	return m.activate(ctx, reboot, false)
}

// ActivateBootstrap arms the first signed transition from the accepted Plan 1
// image while keeping persistent State readable by that fallback image.
func (m *Manager) ActivateBootstrap(ctx context.Context, reboot bool) (Status, error) {
	return m.activate(ctx, reboot, true)
}

func (m *Manager) activate(ctx context.Context, reboot, bootstrap bool) (Status, error) {
	unlock, err := m.lock()
	if err != nil {
		return Status{}, err
	}
	defer unlock()
	current, state, slot, err := m.current()
	if err != nil {
		return Status{}, err
	}
	if err := validateUpdateMode(current, bootstrap); err != nil {
		return Status{}, err
	}
	journal, err := loadJournal(m.config.JournalPath)
	if err != nil {
		return Status{}, err
	}
	if journal.Phase != PhaseStaged && journal.Phase != PhasePending {
		return Status{}, fmt.Errorf("system update is %s, not staged", journal.Phase)
	}
	if slot != journal.ActiveSlot || current.ImageVersion != journal.CurrentImage ||
		state.Slots.Candidate != journal.CandidateSlot || state.Transaction.ID != journal.TransactionID {
		return Status{}, errors.New("staged update no longer matches the running slot or durable transaction")
	}
	transactionManifest, err := m.loadTransactionManifest(journal)
	if err != nil {
		return Status{}, err
	}
	if bootstrap {
		if !state.Transaction.Plan1Compatible() {
			return Status{}, errors.New("Plan 1 bootstrap State is not fallback-compatible")
		}
		if err := m.verifyBootstrapExecutable(transactionManifest); err != nil {
			return Status{}, err
		}
	} else if state.Transaction.Plan1Compatible() {
		return Status{}, errors.New("Plan 1-compatible transaction requires signed bootstrap activation")
	}
	layout, err := m.config.DiscoverLayout(slot)
	if err != nil {
		return Status{}, err
	}
	if err := validateLayoutAgainstState(layout, state); err != nil {
		return Status{}, err
	}
	rootArtifact, _ := transactionManifest.Artifact("system-root")
	if err := m.callVerifyStagedRoot(ctx, layout.InactiveDevice, rootArtifact); err != nil {
		return Status{}, err
	}
	if err := m.callVerifyTarget(ctx, layout.InactiveDevice, transactionManifest); err != nil {
		return Status{}, err
	}
	if err := m.callVerifyBootAssets(ctx, layout, transactionManifest); err != nil {
		return Status{}, err
	}
	state.Transaction.Stage = PhasePending
	if err := appliance.WriteStateAtomic(m.config.StatePath, state); err != nil {
		return Status{}, err
	}
	journal.Phase = PhasePending
	journal.ErrorCode = ""
	journal.Error = ""
	journal.UpdatedAt = m.now()
	if err := writeJournal(m.config.JournalPath, journal); err != nil {
		return Status{}, err
	}
	activeEntry := stableEntryID(layout.ActiveSlot)
	candidateEntry := stableEntryID(layout.InactiveSlot)
	if output, runErr := m.config.Run(ctx, "bootctl", "set-default", activeEntry); runErr != nil {
		return Status{}, fmt.Errorf("protect current System boot selection: %w: %s", runErr, strings.TrimSpace(string(output)))
	}
	if err := m.callCreateBootEntry(layout, transactionManifest); err != nil {
		return Status{}, err
	}
	if output, runErr := m.config.Run(ctx, "bootctl", "set-oneshot", candidateEntry); runErr != nil {
		return Status{}, fmt.Errorf("activate System %s trial: %w: %s", layout.InactiveSlot, runErr, strings.TrimSpace(string(output)))
	}
	if output, runErr := m.config.Run(ctx, "bootctl", "set-default", ""); runErr != nil {
		return Status{}, fmt.Errorf("restore automatic exhausted-entry selection: %w: %s", runErr, strings.TrimSpace(string(output)))
	}
	status, err := m.Status()
	if err != nil {
		return Status{}, err
	}
	if reboot {
		if output, runErr := m.config.Run(ctx, "systemctl", "--no-block", "reboot"); runErr != nil {
			return status, fmt.Errorf("request appliance reboot: %w: %s", runErr, strings.TrimSpace(string(output)))
		}
	}
	return status, nil
}

func (m *Manager) Reconcile(ctx context.Context, options ReconcileOptions) (ReconcileResult, error) {
	unlock, err := m.lock()
	if err != nil {
		return ReconcileResult{}, err
	}
	defer unlock()
	current, state, slot, err := m.current()
	if err != nil {
		return ReconcileResult{}, err
	}
	journal, err := loadJournal(m.config.JournalPath)
	if errors.Is(err, os.ErrNotExist) {
		status, statusErr := m.Status()
		return ReconcileResult{Status: status}, statusErr
	}
	if err != nil {
		return ReconcileResult{}, err
	}

	if slot == journal.CandidateSlot && current.ImageVersion == journal.TargetImage &&
		state.Slots.Current == slot && state.Slots.CurrentImageVersion == current.ImageVersion &&
		state.Slots.Candidate == "" && state.Transaction == (appliance.TransactionState{}) &&
		(journal.Phase == PhasePending || journal.Phase == PhaseTrial) {
		if err := m.persistHealthyUpdateProof(journal); err != nil {
			return ReconcileResult{}, fmt.Errorf("persist healthy System update proof: %w", err)
		}
		if output, runErr := m.config.Run(ctx, "bootctl", "set-default", stableEntryID(slot)); runErr != nil {
			return ReconcileResult{}, fmt.Errorf("pin promoted System %s as the known-good boot default: %w: %s", slot, runErr, strings.TrimSpace(string(output)))
		}
		journal.Phase = PhaseHealthy
		journal.ErrorCode = ""
		journal.Error = ""
		journal.UpdatedAt = m.now()
		if err := writeJournal(m.config.JournalPath, journal); err != nil {
			return ReconcileResult{}, err
		}
		status, err := m.Status()
		return ReconcileResult{Status: status}, err
	}

	if slot == journal.CandidateSlot && current.ImageVersion == journal.TargetImage &&
		(journal.Phase == PhasePending || journal.Phase == PhaseTrial || journal.Phase == PhaseFailed) {
		if state.Transaction.Plan1Compatible() {
			if err := m.verifyBootstrapJournal(state, journal); err != nil {
				return ReconcileResult{}, err
			}
		}
		if output, runErr := m.config.Run(ctx, "bootctl", "set-default", ""); runErr != nil {
			return ReconcileResult{}, fmt.Errorf("enable counted candidate retries: %w: %s", runErr, strings.TrimSpace(string(output)))
		}
		if options.HealthFailed {
			journal.Phase = PhaseFailed
			if journal.TrialFailures < BootAttempts {
				journal.TrialFailures++
			}
			journal.ErrorCode = "candidate_health_failed"
			journal.Error = "candidate failed operational health"
			state.Transaction.Stage = PhaseFailed
		} else {
			journal.Phase = PhaseTrial
			journal.ErrorCode = ""
			journal.Error = ""
			state.Transaction.Stage = PhaseTrial
		}
		journal.UpdatedAt = m.now()
		if err := appliance.WriteStateAtomic(m.config.StatePath, state); err != nil {
			return ReconcileResult{}, err
		}
		if err := writeJournal(m.config.JournalPath, journal); err != nil {
			return ReconcileResult{}, err
		}
		status, err := m.Status()
		return ReconcileResult{Status: status, RebootRequired: options.HealthFailed}, err
	}

	if slot == journal.ActiveSlot && current.ImageVersion == journal.CurrentImage &&
		(journal.Phase == PhasePending || journal.Phase == PhaseTrial || journal.Phase == PhaseFailed) {
		journal.Phase = PhaseRollback
		journal.ErrorCode = "candidate_rolled_back"
		journal.Error = "candidate exhausted bounded boot attempts and the previous known-good slot resumed"
		journal.UpdatedAt = m.now()
		state.Slots.Candidate = ""
		state.Slots.CandidateImageVersion = ""
		state.Transaction = appliance.TransactionState{}
		if err := appliance.WriteStateAtomic(m.config.StatePath, state); err != nil {
			return ReconcileResult{}, err
		}
		layout, layoutErr := m.config.DiscoverLayout(slot)
		if layoutErr == nil {
			_ = m.callRemoveBootEntries(layout)
		}
		if err := writeJournal(m.config.JournalPath, journal); err != nil {
			return ReconcileResult{}, err
		}
	}
	status, err := m.Status()
	return ReconcileResult{Status: status}, err
}

func (m *Manager) MarkHealthy(ctx context.Context) (Status, error) {
	unlock, err := m.lock()
	if err != nil {
		return Status{}, err
	}
	defer unlock()
	current, state, slot, err := m.current()
	if err != nil {
		return Status{}, err
	}
	journal, err := loadJournal(m.config.JournalPath)
	if errors.Is(err, os.ErrNotExist) {
		return m.Status()
	}
	if err != nil {
		return Status{}, err
	}
	if journal.Phase == PhaseRollback || journal.Phase == PhaseHealthy {
		return m.Status()
	}
	if slot != journal.CandidateSlot || current.ImageVersion != journal.TargetImage ||
		state.Slots.Current != slot || state.Slots.CurrentImageVersion != current.ImageVersion {
		return Status{}, errors.New("cannot mark a system update healthy before candidate slot promotion")
	}
	if err := m.persistHealthyUpdateProof(journal); err != nil {
		return Status{}, fmt.Errorf("persist healthy System update proof: %w", err)
	}
	if output, runErr := m.config.Run(ctx, "bootctl", "set-default", stableEntryID(slot)); runErr != nil {
		return Status{}, fmt.Errorf("pin promoted System %s as the known-good boot default: %w: %s", slot, runErr, strings.TrimSpace(string(output)))
	}
	journal.Phase = PhaseHealthy
	journal.ErrorCode = ""
	journal.Error = ""
	journal.UpdatedAt = m.now()
	if err := writeJournal(m.config.JournalPath, journal); err != nil {
		return Status{}, err
	}
	return m.Status()
}

func (m *Manager) verifyBootstrapExecutable(manifest Manifest) error {
	updater, ok := manifest.Artifact("system-updater")
	if !ok {
		return errors.New("signed transaction has no bootstrap updater artifact")
	}
	executable, err := m.config.ExecutablePath()
	if err != nil {
		return fmt.Errorf("resolve running bootstrap updater: %w", err)
	}
	if err := verifyFile(executable, updater.SizeBytes, updater.SHA256); err != nil {
		return fmt.Errorf("running bootstrap updater is not the signed target updater: %w", err)
	}
	return nil
}

func (m *Manager) verifyBootstrapJournal(state appliance.StateRecord, journal Journal) error {
	if state.Transaction.ID != journal.TransactionID || state.Transaction.TargetImageVersion != journal.TargetImage || state.Slots.Candidate != journal.CandidateSlot {
		return errors.New("Plan 1-compatible State does not match the durable system update journal")
	}
	_, err := m.loadTransactionManifest(journal)
	return err
}

func validateUpdateMode(current appliance.Manifest, bootstrap bool) error {
	native := appliance.ApplianceCapabilities(current).ImageUpdate
	if bootstrap && native {
		return errors.New("Plan 1 bootstrap is not valid on a native system-update image")
	}
	if !bootstrap && !native {
		return errors.New("this appliance predates native system updates; use the signed Plan 1 bootstrap artifact once")
	}
	return nil
}

func (m *Manager) resolve(ctx context.Context, options SourceOptions) (VerifiedManifest, Layout, appliance.StateRecord, Journal, error) {
	if strings.TrimSpace(options.ManifestSource) == "" {
		return VerifiedManifest{}, Layout{}, appliance.StateRecord{}, Journal{}, errors.New("manifest source is required")
	}
	if strings.TrimSpace(options.SignatureSource) == "" {
		options.SignatureSource = options.ManifestSource + ".sig"
	}
	current, state, activeSlot, err := m.current()
	if err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	if err := validateUpdateMode(current, options.Bootstrap); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	if state.Slots.Current != activeSlot || state.Slots.CurrentImageVersion != current.ImageVersion {
		return VerifiedManifest{}, Layout{}, state, Journal{}, errors.New("running System slot does not match durable known-good appliance state")
	}
	layout, err := m.config.DiscoverLayout(activeSlot)
	if err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	if err := validateLayoutAgainstState(layout, state); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}

	incomingDir := filepath.Join(m.config.CacheDir, "incoming")
	if err := os.MkdirAll(incomingDir, 0700); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	manifestPath := filepath.Join(incomingDir, "system-update-manifest.json")
	signaturePath := manifestPath + ".sig"
	if err := m.downloadSourceAtMost(ctx, options.ManifestSource, manifestPath+".part", manifestPath, maxManifestBytes); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, fmt.Errorf("download system update manifest: %w", err)
	}
	if err := m.downloadSourceAtMost(ctx, options.SignatureSource, signaturePath+".part", signaturePath, maxSignatureBytes); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, fmt.Errorf("download system update signature: %w", err)
	}
	verified, err := VerifyManifest(manifestPath, signaturePath, m.config.TrustKeyPath)
	if err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	expectedDigest := strings.ToLower(strings.TrimSpace(options.ExpectedManifestSHA256))
	if expectedDigest != "" {
		if len(expectedDigest) != 64 || !isLowerHex(expectedDigest) {
			return VerifiedManifest{}, Layout{}, state, Journal{}, errors.New("expected manifest SHA-256 must be 64 lowercase hexadecimal characters")
		}
		if verified.SHA256 != expectedDigest {
			return VerifiedManifest{}, Layout{}, state, Journal{}, fmt.Errorf("system update manifest digest mismatch: got %s, expected %s", verified.SHA256, expectedDigest)
		}
	}
	if err := verified.Manifest.validateCurrent(current, state, options.AllowTest, options.AllowCurrent); err != nil {
		var compatibility *CurrentCompatibilityError
		if errors.As(err, &compatibility) && compatibility.Code == "bridge_required" {
			compatibility.ManifestSHA256 = verified.SHA256
			compatibility.TargetImage = verified.Manifest.TargetImageVersion
			compatibility.ReleaseBranch = verified.Manifest.ReleaseSet.Branch
		}
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	if expected := strings.TrimSpace(options.ExpectedReleaseBranch); expected != "" && verified.Manifest.ReleaseSet.Branch != expected {
		return VerifiedManifest{}, Layout{}, state, Journal{}, fmt.Errorf("signed platform bundle branch %q does not match requested branch %q", verified.Manifest.ReleaseSet.Branch, expected)
	}
	if options.Bootstrap {
		if err := m.verifyBootstrapExecutable(verified.Manifest); err != nil {
			return VerifiedManifest{}, Layout{}, state, Journal{}, err
		}
	}

	if options.discoveryOnly && verified.Manifest.TargetImageVersion == current.ImageVersion {
		// Equality is only a no-op for the installed signed source and component
		// set. A same-version rebuild must not replace the installed identity.
		if verified.Manifest.SourceCommit != current.SourceCommit || current.ReleaseSet == nil ||
			!reflect.DeepEqual(verified.Manifest.ReleaseSet, *current.ReleaseSet) {
			return VerifiedManifest{}, Layout{}, state, Journal{}, errors.New("same-version system release does not match the installed identity")
		}
		return verified, layout, state, Journal{}, nil
	}

	existing, existingErr := loadJournal(m.config.JournalPath)
	if existingErr == nil && existing.ManifestSHA256 == verified.SHA256 {
		return verified, layout, state, existing, nil
	}
	if existingErr == nil {
		switch existing.Phase {
		case PhaseAvailable, PhaseDownload, PhaseWriting, PhaseStaged, PhasePending, PhaseTrial:
			return VerifiedManifest{}, Layout{}, state, Journal{}, errors.New("a different system update transaction is already active")
		case PhaseFailed:
			if !options.ReplaceFailed {
				return VerifiedManifest{}, Layout{}, state, Journal{}, errors.New("a different failed system update exists; retry with --replace-failed after renewed confirmation")
			}
		}
	} else if !errors.Is(existingErr, os.ErrNotExist) {
		return VerifiedManifest{}, Layout{}, state, Journal{}, existingErr
	}

	transactionID := "update-" + verified.SHA256[:24]
	journal := Journal{
		Schema: JournalSchema, TransactionID: transactionID, ManifestSHA256: verified.SHA256,
		CurrentImage: current.ImageVersion,
		TargetImage:  verified.Manifest.TargetImageVersion,
		ActiveSlot:   activeSlot, CandidateSlot: layout.InactiveSlot, Phase: PhaseAvailable,
		DownloadedBytes: map[string]int64{}, StartedAt: m.now(), UpdatedAt: m.now(),
		Channel: strings.TrimSpace(options.Channel), ReleaseTag: strings.TrimSpace(options.ReleaseTag),
		ReleaseNotes: strings.TrimSpace(options.ReleaseNotes),
	}
	transactionDir := m.transactionDir(transactionID)
	if err := os.MkdirAll(transactionDir, 0700); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	if err := atomicCopy(manifestPath, filepath.Join(transactionDir, "system-update-manifest.json"), 0600); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	if err := atomicCopy(signaturePath, filepath.Join(transactionDir, "system-update-manifest.json.sig"), 0600); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	if err := writeJournal(m.config.JournalPath, journal); err != nil {
		return VerifiedManifest{}, Layout{}, state, Journal{}, err
	}
	return verified, layout, state, journal, nil
}

func (m *Manager) current() (appliance.Manifest, appliance.StateRecord, string, error) {
	raw, err := os.ReadFile(m.config.CurrentManifestPath)
	if err != nil {
		return appliance.Manifest{}, appliance.StateRecord{}, "", fmt.Errorf("read running appliance manifest: %w", err)
	}
	manifest, err := appliance.ParseManifest(raw)
	if err != nil {
		return appliance.Manifest{}, appliance.StateRecord{}, "", err
	}
	state, err := appliance.LoadState(m.config.StatePath)
	if err != nil {
		return appliance.Manifest{}, appliance.StateRecord{}, "", err
	}
	cmdline, err := os.ReadFile(m.config.KernelCmdlinePath)
	if err != nil {
		return appliance.Manifest{}, appliance.StateRecord{}, "", err
	}
	slot, err := appliance.SystemSlotFromKernelCommandLine(string(cmdline))
	return manifest, state, slot, err
}

func (m *Manager) loadTransactionManifest(journal Journal) (Manifest, error) {
	manifestPath := filepath.Join(m.transactionDir(journal.TransactionID), "system-update-manifest.json")
	verified, err := VerifyManifest(manifestPath, manifestPath+".sig", m.config.TrustKeyPath)
	if err != nil && journal.Phase == PhaseHealthy && errors.Is(err, os.ErrNotExist) {
		manifestPath = m.config.HealthyManifestPath
		verified, err = VerifyManifest(manifestPath, manifestPath+".sig", m.config.TrustKeyPath)
	}
	if err != nil {
		return Manifest{}, err
	}
	manifest := verified.Manifest
	if verified.SHA256 != journal.ManifestSHA256 {
		return Manifest{}, errors.New("staged signed manifest digest no longer matches the durable journal")
	}
	if manifest.TargetImageVersion != journal.TargetImage {
		return Manifest{}, errors.New("staged system update manifest no longer matches the durable journal")
	}
	return manifest, nil
}

func (m *Manager) persistHealthyUpdateProof(journal Journal) error {
	manifestPath := filepath.Join(m.transactionDir(journal.TransactionID), "system-update-manifest.json")
	verified, err := VerifyManifest(manifestPath, manifestPath+".sig", m.config.TrustKeyPath)
	if err != nil {
		return err
	}
	if verified.SHA256 != journal.ManifestSHA256 || verified.Manifest.TargetImageVersion != journal.TargetImage {
		return errors.New("signed System update proof does not match the durable journal")
	}
	if err := atomicCopy(manifestPath, m.config.HealthyManifestPath, 0o600); err != nil {
		return err
	}
	return atomicCopy(manifestPath+".sig", m.config.HealthyManifestPath+".sig", 0o600)
}

func (m *Manager) transactionDir(id string) string { return filepath.Join(m.config.CacheDir, id) }
func (m *Manager) now() string                     { return m.config.Now().UTC().Format(time.RFC3339) }

func (m *Manager) lock() (func(), error) {
	path := m.config.JournalPath + ".lock"
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("another system update operation is active")
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}

func filesystemAvailableBytes(path string) (uint64, error) {
	if err := os.MkdirAll(path, 0700); err != nil {
		return 0, err
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return stat.Bavail * uint64(stat.Bsize), nil
}

func requiredArtifactBytes(manifest Manifest, transactionDir string) (uint64, error) {
	var required uint64
	for _, artifact := range manifest.Artifacts {
		destination := filepath.Join(transactionDir, filepath.Base(artifact.Path))
		if info, err := os.Stat(destination); err == nil && info.Size() == artifact.SizeBytes {
			continue
		}
		if artifact.SizeBytes <= 0 || uint64(artifact.SizeBytes) > ^uint64(0)-required {
			return 0, errors.New("system update artifact sizes overflow cache capacity accounting")
		}
		required += uint64(artifact.SizeBytes)
	}
	return required, nil
}

func stableEntryID(slot string) string { return "youeye-system-" + strings.ToLower(slot) + ".conf" }

func cloneBytes(values map[string]int64) map[string]int64 {
	if len(values) == 0 {
		return nil
	}
	clone := make(map[string]int64, len(values))
	for key, value := range values {
		clone[key] = value
	}
	return clone
}

// Signed CDN query parameters are transport details, not manifest source inputs.
// Only GitHub's HTTPS release redirect may introduce them.
func validateSystemUpdateDownloadURL(target, origin *url.URL) error {
	if err := validateRemoteURL(origin); err != nil {
		return err
	}
	if target == nil {
		return validateRemoteURL(target)
	}
	if origin.Scheme == "https" && target.Scheme != "https" {
		return errors.New("system update redirect must preserve HTTPS")
	}
	candidate := *target
	if origin.Scheme == "https" && strings.EqualFold(origin.Host, "github.com") &&
		target.Scheme == "https" && (strings.EqualFold(target.Host, "release-assets.githubusercontent.com") || strings.EqualFold(target.Host, "objects.githubusercontent.com")) {
		candidate.RawQuery = ""
	}
	return validateRemoteURL(&candidate)
}
