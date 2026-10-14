package systemupdate

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"

	"github.com/youeye-platform/YouEye/appliance/ordering"
	"github.com/youeye-platform/YouEye/releasecache"
	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// NativeCoreAuthority reads live machine, channel and scoped trust policy for
// every action. Discovery can veto a staged selection, but never replace it.
// After checkpoint intent, continuation uses the frozen selection: a newer
// published head is not permission to change an in-flight data transaction.
type NativeCoreAuthority struct {
	Checkpoint            NativeCoreCheckpoint
	TrustKeyPath          string
	Client                *http.Client
	FirstBootPolicyPath   string
	FirstBootCompletePath string
	CurrentSelection      func() (CoreReleaseSelection, error)
}

func coreBeforeCheckpoint(j CoreJournal) bool {
	for _, s := range j.Steps {
		if s.Name == "checkpoint" {
			return s.State == "pending"
		}
	}
	return true
}

func validateCoreChannelSelection(selection CoreReleaseSelection, r releasecache.CoreRelease, digest string) error {
	if selection.Source != r.Source || !releasecache.ValidCoreBranch(selection.Branch) {
		return fmt.Errorf("selected System source changed")
	}
	if selection.Tag != "" {
		if selection.Tag != r.Tag || selection.ManifestSHA256 != digest || selection.Branch != r.Branch {
			return fmt.Errorf("selected System pin changed")
		}
		return nil
	}
	if selection.ManifestSHA256 != "" {
		return fmt.Errorf("System digest requires an exact pin")
	}
	allowed := selection.Branch == r.Branch
	for _, branch := range selection.Fallback {
		if !releasecache.ValidCoreBranch(branch) {
			return fmt.Errorf("invalid current fallback branch")
		}
		allowed = allowed || branch == r.Branch
	}
	if !allowed {
		return fmt.Errorf("frozen System branch is no longer selected")
	}
	return nil
}

func validateCoreCompatibility(r releasecache.CoreRelease, state appliance.StateRecord, installedVersion string) error {
	c := r.Compatibility
	if state.SchemaVersion < c.StateMin || state.SchemaVersion > c.StateMax || state.DataSchemaVersion < c.DataMin || state.DataSchemaVersion > c.DataMax {
		return fmt.Errorf("core release is incompatible with persistent State or Data")
	}
	minimum, err := ordering.ParseVersion(c.MinimumRelease)
	if err != nil {
		return err
	}
	installed, err := ordering.ParseVersion(installedVersion)
	if err != nil {
		return err
	}
	if ordering.CompareVersion(minimum, installed) > 0 {
		return fmt.Errorf("core release requires a newer installed bridge release")
	}
	for _, capability := range c.Capabilities {
		if capability != "core-release-v1" {
			return fmt.Errorf("core release requires an unsupported reader capability")
		}
	}
	return nil
}

func (a NativeCoreAuthority) verify(ctx context.Context, j CoreJournal, recovery bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !filepath.IsAbs(a.Checkpoint.DataRoot) {
		return fmt.Errorf("exact installed Data root required")
	}
	reservation, reservationErr := (CoreLifecycleBarrier{Root: filepath.Join(a.Checkpoint.DataRoot, "state", "app-updates")}).Read()
	if reservationErr == nil {
		if reservation.RequestID != j.RequestID || reservation.ManifestSHA256 != j.ManifestSHA256 {
			return fmt.Errorf("another core transaction still owns platform maintenance")
		}
	} else if !errors.Is(reservationErr, os.ErrNotExist) {
		return reservationErr
	}
	machine, err := a.Checkpoint.observeMachine()
	if err != nil || machine != j.Previous.Machine {
		return fmt.Errorf("current hardware differs from the core transaction")
	}
	m := CoreManager{Root: a.Checkpoint.Root}
	current, err := m.ReadReceipt()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(current, j.Previous) && (recovery || current.ManifestSHA256 != j.ManifestSHA256 || !reflect.DeepEqual(current.Release, j.Target) || current.Machine != machine) {
		return fmt.Errorf("installed receipt changed outside the core transaction")
	}
	r, digest := j.Target, j.ManifestSHA256
	if recovery {
		r, digest = j.Previous.Release, j.Previous.ManifestSHA256
	}
	_, verified, err := m.Selection(digest, a.TrustKeyPath)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(verified, r) {
		return fmt.Errorf("frozen signed core differs from coordinator")
	}
	for _, member := range r.Members {
		if err = CheckCoreMemberAuthority(member, r.Channel, a.TrustKeyPath); err != nil {
			return err
		}
	}
	state, err := appliance.LoadState(a.Checkpoint.StatePath)
	if err != nil {
		return err
	}
	return validateCoreCompatibility(r, state, j.Previous.Release.Version)
}

func (a NativeCoreAuthority) AuthorizeTarget(ctx context.Context, j CoreJournal, activation bool) error {
	if a.CurrentSelection == nil {
		return fmt.Errorf("live System source policy required")
	}
	if err := a.verify(ctx, j, false); err != nil {
		return err
	}
	selection, err := a.CurrentSelection()
	if err != nil {
		return err
	}
	if err = validateCoreChannelSelection(selection, j.Target, j.ManifestSHA256); err != nil {
		return err
	}
	// A request waiting for restart must still be the policy-selected release
	// before capture. Once effects start, only exact authority is rechecked.
	if coreBeforeCheckpoint(j) && (j.Phase == "prepared" || activation || !j.RestartRequired) {
		offline, err := a.allowOfflineFirstBoot(j)
		if err != nil {
			return err
		}
		if offline {
			return nil
		}
		_, selected, digest, err := ResolveCoreRelease(ctx, a.Client, selection, a.TrustKeyPath)
		if err != nil {
			return err
		}
		if digest != j.ManifestSHA256 || !reflect.DeepEqual(selected, j.Target) {
			return fmt.Errorf("System selection changed; cancel or recover this request before selecting another release")
		}
	}
	return nil
}

// Current channel changes do not implicitly prohibit recovery to the retained
// previous release. Its independent authority, compatibility and machine must
// still pass; revoked previous keys never fall back to the failed target.
func (a NativeCoreAuthority) AuthorizePrevious(ctx context.Context, j CoreJournal) error {
	return a.verify(ctx, j, true)
}
