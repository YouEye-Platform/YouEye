package systemupdate

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

const ReleasePolicySchema = "youeye.release-policy.v1"

type ReleasePolicy struct {
	ServiceSelection string `json:"service_selection,omitempty"`
	Schema           string `json:"schema"`
	Provider         string `json:"provider"`
	ReleasesAPI      string `json:"releases_api,omitempty"`
	Mode             string `json:"mode"`
	Track            string `json:"track,omitempty"`
	Branch           string `json:"branch,omitempty"`
	ExactTag         string `json:"exact_tag,omitempty"`
	ManifestSHA256   string `json:"manifest_sha256,omitempty"`
	Freshness        string `json:"freshness"`
}

type exactBundleManifest struct {
	Schema       string               `json:"schema"`
	ImageVersion string               `json:"image_version"`
	SourceCommit string               `json:"source_commit"`
	Trust        Trust                `json:"trust"`
	ReleaseSet   appliance.ReleaseSet `json:"release_set"`
}

type ConvergenceResult struct {
	Schema          string `json:"schema"`
	Action          string `json:"action"`
	SelectedTag     string `json:"selected_tag,omitempty"`
	ManifestSHA256  string `json:"manifest_sha256,omitempty"`
	CurrentImage    string `json:"current_image"`
	TargetImage     string `json:"target_image"`
	Bridge          bool   `json:"bridge"`
	RebootRequested bool   `json:"reboot_requested"`
	Status          Status `json:"status"`
}

const convergenceIntentSchema = "youeye.first-boot-convergence-intent.v1"

type convergenceIntent struct {
	Schema         string   `json:"schema"`
	SelectedTag    string   `json:"selected_tag"`
	ManifestSHA256 string   `json:"manifest_sha256"`
	TargetImage    string   `json:"target_image"`
	ReleaseBranch  string   `json:"release_branch"`
	Bridges        []string `json:"bridges,omitempty"`
	UpdatedAt      string   `json:"updated_at"`
}

func (intent convergenceIntent) validate() error {
	if intent.Schema != convergenceIntentSchema || !validExactReleaseTag(intent.SelectedTag) || !validSHA256(intent.ManifestSHA256) || strings.TrimSpace(intent.TargetImage) == "" || !validReleaseBranch(intent.ReleaseBranch) || strings.TrimSpace(intent.UpdatedAt) == "" {
		return errors.New("first-boot convergence intent is invalid")
	}
	for _, bridge := range intent.Bridges {
		if !validExactReleaseTag(bridge) || bridge == intent.SelectedTag {
			return errors.New("first-boot convergence bridge identity is invalid")
		}
	}
	return nil
}

func loadConvergenceIntent(path string) (convergenceIntent, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return convergenceIntent{}, err
	}
	var intent convergenceIntent
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&intent); err != nil {
		return convergenceIntent{}, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return convergenceIntent{}, errors.New("first-boot convergence intent contains trailing JSON")
	}
	return intent, intent.validate()
}

func writeConvergenceIntent(path string, intent convergenceIntent) error {
	intent.Schema = convergenceIntentSchema
	if err := intent.validate(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(intent, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(raw, '\n'), 0o600)
}

func pinConvergenceCandidates(options []SourceOptions, intent convergenceIntent) ([]SourceOptions, error) {
	for index := range options {
		if options[index].ReleaseTag != intent.SelectedTag {
			continue
		}
		pinned := append([]SourceOptions(nil), options[index:]...)
		pinned[0].ExpectedManifestSHA256 = intent.ManifestSHA256
		return pinned, nil
	}
	return nil, fmt.Errorf("selected signed platform bundle %q is no longer available from its release track", intent.SelectedTag)
}

func LoadReleasePolicy(path string) (ReleasePolicy, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ReleasePolicy{}, fmt.Errorf("read first-boot release policy: %w", err)
	}
	var policy ReleasePolicy
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return ReleasePolicy{}, fmt.Errorf("decode first-boot release policy: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ReleasePolicy{}, errors.New("first-boot release policy contains trailing JSON")
	}
	if err := policy.Validate(); err != nil {
		return ReleasePolicy{}, err
	}
	return policy, nil
}

func (policy ReleasePolicy) Validate() error {
	if policy.Schema != ReleasePolicySchema {
		return fmt.Errorf("unsupported first-boot release policy schema %q", policy.Schema)
	}
	if policy.ServiceSelection != "" && policy.ServiceSelection != "sealed" && policy.ServiceSelection != "current" {
		return fmt.Errorf("service selection must be sealed or current")
	}
	if policy.ServiceSelection == "current" && policy.Provider != "github" {
		return fmt.Errorf("current service selection requires official public distribution")
	}
	if policy.Freshness != "require-current" && policy.Freshness != "prefer-current" {
		return errors.New("first-boot freshness must be require-current or prefer-current")
	}
	provider := strings.ToLower(strings.TrimSpace(policy.Provider))
	if _, _, err := normalizeReleaseSource(provider, policy.ReleasesAPI); err != nil {
		return err
	}
	switch policy.Mode {
	case "track":
		if policy.ExactTag != "" || policy.ManifestSHA256 != "" {
			return errors.New("tracking first-boot policy cannot include an exact identity")
		}
		switch policy.Track {
		case "stable", "development":
			if policy.Branch != "" {
				return errors.New("Stable and Development tracks cannot include a branch")
			}
		case "branch":
			if !validReleaseBranch(policy.Branch) {
				return errors.New("branch track requires a safe signed release branch")
			}
		default:
			return errors.New("first-boot track must be stable, development, or branch")
		}
	case "exact":
		if policy.Track != "" || policy.Branch != "" || !validExactReleaseTag(policy.ExactTag) || len(policy.ManifestSHA256) != 64 || !isLowerHex(policy.ManifestSHA256) {
			return errors.New("Exact first-boot policy requires an appliance tag and lowercase appliance-manifest SHA-256")
		}
	default:
		return errors.New("first-boot release policy mode must be track or exact")
	}
	return nil
}

func (policy ReleasePolicy) Selection() ReleaseSelection {
	return ReleaseSelection{
		Provider: policy.Provider, ReleasesAPI: policy.ReleasesAPI,
		Channel: policy.Track, Branch: policy.Branch,
	}
}

func verifyExactInstalledMedia(policy ReleasePolicy, bundleManifestPath, bundleSignaturePath, trustKeyPath string) (exactBundleManifest, string, error) {
	if policy.Mode != "exact" {
		return exactBundleManifest{}, "", errors.New("exact media verification requires Exact policy")
	}
	raw, err := os.ReadFile(bundleManifestPath)
	if err != nil {
		return exactBundleManifest{}, "", fmt.Errorf("read installed signed appliance manifest: %w", err)
	}
	digest := sha256.Sum256(raw)
	digestHex := hex.EncodeToString(digest[:])
	if digestHex != policy.ManifestSHA256 {
		return exactBundleManifest{}, "", errors.New("installed appliance manifest does not match the Exact policy digest")
	}
	publicKey, err := readPublicKey(trustKeyPath)
	if err != nil {
		return exactBundleManifest{}, "", err
	}
	signature, err := readSignature(bundleSignaturePath)
	if err != nil {
		return exactBundleManifest{}, "", err
	}
	if !ed25519.Verify(publicKey, raw, signature) {
		return exactBundleManifest{}, "", errors.New("installed appliance manifest signature is invalid")
	}
	var bundle exactBundleManifest
	if err := json.Unmarshal(raw, &bundle); err != nil {
		return exactBundleManifest{}, "", fmt.Errorf("decode installed signed appliance manifest: %w", err)
	}
	if bundle.Schema != "youeye.appliance.manifest.v1" || bundle.ImageVersion == "" || bundle.SourceCommit == "" {
		return exactBundleManifest{}, "", errors.New("installed signed appliance manifest identity is incomplete")
	}
	keyID, err := publicKeyID(publicKey)
	if err != nil {
		return exactBundleManifest{}, "", err
	}
	if bundle.Trust.KeyID != keyID {
		return exactBundleManifest{}, "", errors.New("installed appliance manifest trust identity does not match the trust anchor")
	}
	wantTag := exactTagForReleaseSet(bundle.ReleaseSet.Branch, bundle.ImageVersion)
	if policy.ExactTag != wantTag {
		return exactBundleManifest{}, "", fmt.Errorf("Exact policy tag %q does not match signed installed identity %q", policy.ExactTag, wantTag)
	}
	return bundle, digestHex, nil
}

func VerifyExactInstalled(policy ReleasePolicy, currentManifestPath, bundleManifestPath, bundleSignaturePath, trustKeyPath string) (ConvergenceResult, error) {
	bundle, digestHex, err := verifyExactInstalledMedia(policy, bundleManifestPath, bundleSignaturePath, trustKeyPath)
	if err != nil {
		return ConvergenceResult{}, err
	}
	currentRaw, err := os.ReadFile(currentManifestPath)
	if err != nil {
		return ConvergenceResult{}, fmt.Errorf("read running sealed appliance manifest: %w", err)
	}
	current, err := appliance.ParseManifest(currentRaw)
	if err != nil {
		return ConvergenceResult{}, err
	}
	if current.ReleaseSet == nil || current.ImageVersion != bundle.ImageVersion || current.SourceCommit != bundle.SourceCommit || !reflect.DeepEqual(*current.ReleaseSet, bundle.ReleaseSet) {
		return ConvergenceResult{}, errors.New("running sealed System does not match the Exact signed appliance manifest")
	}
	status := Status{Schema: StatusSchema, State: PhaseHealthy, CurrentImage: current.ImageVersion, RunningImage: current.ImageVersion, TargetImage: current.ImageVersion}
	return ConvergenceResult{
		Schema: "youeye.first-boot-convergence.v1", Action: "exact-media-current",
		SelectedTag: policy.ExactTag, ManifestSHA256: digestHex,
		CurrentImage: current.ImageVersion, TargetImage: current.ImageVersion, Status: status,
	}, nil
}

func (m *Manager) VerifyHealthyPromotedExact(policy ReleasePolicy, bundleManifestPath, bundleSignaturePath string) (ConvergenceResult, error) {
	media, _, err := verifyExactInstalledMedia(policy, bundleManifestPath, bundleSignaturePath, m.config.TrustKeyPath)
	if err != nil {
		return ConvergenceResult{}, err
	}
	current, state, slot, err := m.current()
	if err != nil {
		return ConvergenceResult{}, err
	}
	if current.ReleaseSet == nil || current.ImageVersion == media.ImageVersion || current.ReleaseSet.Branch != media.ReleaseSet.Branch {
		return ConvergenceResult{}, errors.New("running System is not a same-track post-install promotion")
	}
	if state.Slots.Current != slot || state.Slots.CurrentImageVersion != current.ImageVersion || state.Slots.Candidate != "" || state.Transaction != (appliance.TransactionState{}) {
		return ConvergenceResult{}, errors.New("running System does not match durable promoted appliance state")
	}
	journal, err := loadJournal(m.config.JournalPath)
	if err != nil {
		return ConvergenceResult{}, err
	}
	if journal.Phase != PhaseHealthy || journal.CandidateSlot != slot || journal.TargetImage != current.ImageVersion || journal.ReleaseTag != exactTagForReleaseSet(current.ReleaseSet.Branch, current.ImageVersion) {
		return ConvergenceResult{}, errors.New("durable System update journal does not identify the running healthy promotion")
	}
	promotion, err := m.loadTransactionManifest(journal)
	if err != nil {
		return ConvergenceResult{}, err
	}
	if promotion.TargetImageVersion != current.ImageVersion || promotion.SourceCommit != current.SourceCommit || !reflect.DeepEqual(promotion.ReleaseSet, *current.ReleaseSet) {
		return ConvergenceResult{}, errors.New("signed System update transaction does not match the running sealed release set")
	}
	status := Status{Schema: StatusSchema, State: PhaseHealthy, CurrentImage: current.ImageVersion, RunningImage: current.ImageVersion, TargetImage: current.ImageVersion, ActiveSlot: slot, ManifestSHA256: journal.ManifestSHA256, Channel: journal.Channel, ReleaseTag: journal.ReleaseTag}
	return ConvergenceResult{
		Schema: "youeye.first-boot-convergence.v1", Action: "exact-updated-current",
		SelectedTag: journal.ReleaseTag, ManifestSHA256: journal.ManifestSHA256,
		CurrentImage: current.ImageVersion, TargetImage: current.ImageVersion, Status: status,
	}, nil
}

func VerifyCurrentTrack(policy ReleasePolicy, currentManifestPath string) (ConvergenceResult, error) {
	raw, err := os.ReadFile(currentManifestPath)
	if err != nil {
		return ConvergenceResult{}, err
	}
	current, err := appliance.ParseManifest(raw)
	if err != nil {
		return ConvergenceResult{}, err
	}
	if current.ReleaseSet == nil {
		return ConvergenceResult{}, errors.New("running sealed System has no signed release set")
	}
	want := ""
	switch policy.Track {
	case "stable":
		want = "main"
	case "development":
		want = "dev"
	case "branch":
		want = policy.Branch
	}
	if current.ReleaseSet.Branch != want {
		return ConvergenceResult{}, fmt.Errorf("media branch %q cannot satisfy requested track %q while the release source is unavailable", current.ReleaseSet.Branch, want)
	}
	status := Status{Schema: StatusSchema, State: PhaseHealthy, CurrentImage: current.ImageVersion, RunningImage: current.ImageVersion, TargetImage: current.ImageVersion}
	return ConvergenceResult{
		Schema: "youeye.first-boot-convergence.v1", Action: "media-current-source-unavailable",
		CurrentImage: current.ImageVersion, TargetImage: current.ImageVersion, Status: status,
	}, nil
}

func (m *Manager) Converge(ctx context.Context, options []SourceOptions, reboot bool) (ConvergenceResult, error) {
	if len(options) == 0 {
		return ConvergenceResult{}, errors.New("no signed platform bundle candidates were resolved")
	}
	intent, intentErr := loadConvergenceIntent(m.config.ConvergencePath)
	if intentErr == nil {
		var err error
		options, err = pinConvergenceCandidates(options, intent)
		if err != nil {
			return ConvergenceResult{}, err
		}
	} else if !errors.Is(intentErr, os.ErrNotExist) {
		return ConvergenceResult{}, fmt.Errorf("read durable first-boot convergence intent: %w", intentErr)
	}
	bridgeRequired := intentErr == nil && len(intent.Bridges) > 0
	for index, candidate := range options {
		status, err := m.Stage(ctx, candidate)
		if err != nil {
			if BridgeRequired(err) {
				var compatibility *CurrentCompatibilityError
				if !errors.As(err, &compatibility) || !validSHA256(compatibility.ManifestSHA256) || compatibility.TargetImage == "" || !validReleaseBranch(compatibility.ReleaseBranch) {
					return ConvergenceResult{}, errors.New("signed bridge requirement did not retain the selected bundle identity")
				}
				if intentErr != nil {
					intent = convergenceIntent{
						Schema: convergenceIntentSchema, SelectedTag: candidate.ReleaseTag,
						ManifestSHA256: compatibility.ManifestSHA256, TargetImage: compatibility.TargetImage,
						ReleaseBranch: compatibility.ReleaseBranch, UpdatedAt: m.now(),
					}
					if err := writeConvergenceIntent(m.config.ConvergencePath, intent); err != nil {
						return ConvergenceResult{}, err
					}
					intentErr = nil
				}
				bridgeRequired = true
				continue
			}
			return ConvergenceResult{}, err
		}
		if bridgeRequired && status.RunningImage == status.TargetImage && candidate.ReleaseTag != intent.SelectedTag {
			return ConvergenceResult{}, errors.New("the requested signed platform bundle needs a bridge, but no newer compatible signed bridge was found")
		}
		result := ConvergenceResult{
			Schema: "youeye.first-boot-convergence.v1", SelectedTag: candidate.ReleaseTag,
			ManifestSHA256: status.ManifestSHA256, CurrentImage: status.RunningImage,
			TargetImage: status.TargetImage, Bridge: bridgeRequired || index > 0, Status: status,
		}
		if status.RunningImage == status.TargetImage {
			if intentErr == nil && candidate.ReleaseTag != intent.SelectedTag {
				return ConvergenceResult{}, errors.New("signed bridge became current without reaching the selected final bundle")
			}
			result.Action = "current"
			if intentErr == nil {
				if err := os.Remove(m.config.ConvergencePath); err != nil && !errors.Is(err, os.ErrNotExist) {
					return ConvergenceResult{}, err
				}
			}
			return result, nil
		}
		if status.State != PhaseStaged && status.State != PhasePending {
			return ConvergenceResult{}, fmt.Errorf("signed System convergence stopped in unexpected state %q", status.State)
		}
		if intentErr != nil {
			intent = convergenceIntent{
				Schema: convergenceIntentSchema, SelectedTag: candidate.ReleaseTag,
				ManifestSHA256: status.ManifestSHA256, TargetImage: status.TargetImage,
				ReleaseBranch: candidate.ExpectedReleaseBranch, UpdatedAt: m.now(),
			}
			if err := writeConvergenceIntent(m.config.ConvergencePath, intent); err != nil {
				return ConvergenceResult{}, err
			}
			intentErr = nil
		} else if candidate.ReleaseTag != intent.SelectedTag {
			alreadyRecorded := false
			for _, bridge := range intent.Bridges {
				alreadyRecorded = alreadyRecorded || bridge == candidate.ReleaseTag
			}
			if !alreadyRecorded {
				intent.Bridges = append(intent.Bridges, candidate.ReleaseTag)
				intent.UpdatedAt = m.now()
				if err := writeConvergenceIntent(m.config.ConvergencePath, intent); err != nil {
					return ConvergenceResult{}, err
				}
			}
		}
		activated, err := m.Activate(ctx, reboot)
		if err != nil {
			return ConvergenceResult{}, err
		}
		result.Action = "system-restart"
		result.RebootRequested = reboot
		result.Status = activated
		return result, nil
	}
	return ConvergenceResult{}, errors.New("no compatible signed System or bridge release was found for this media")
}

func ResolvePolicyCandidates(ctx context.Context, client *http.Client, policy ReleasePolicy) ([]SourceOptions, error) {
	options, _, err := ResolveReleaseCandidates(ctx, client, policy.Selection())
	for index := range options {
		options[index].AllowCurrent = true
	}
	return options, err
}

func exactTagForReleaseSet(branch, version string) string {
	switch branch {
	case "main":
		return "appliance-v" + version
	case "dev":
		return "appliance-dev-v" + version
	default:
		return "appliance-" + branch + "-v" + version
	}
}
