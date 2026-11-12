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

// NativeCoreAuthority reads the live machine and the installer-recorded release
// policy for every action. CurrentSelection must be host-owned (never derived
// from Control Panel writable configuration). Discovery can veto a staged
// selection, but never replace it.
// After checkpoint intent, continuation uses the frozen selection: a newer
// published head is not permission to change an in-flight data transaction.
type NativeCoreAuthority struct {
	Checkpoint NativeCoreCheckpoint
	Client     *http.Client
}

func coreBeforeCheckpoint(j CoreJournal) bool {
	for _, s := range j.Steps {
		if s.Name == "checkpoint" {
			return s.State == "pending"
		}
	}
	return true
}

func validateCoreCompatibility(r releasecache.CoreRelease, state appliance.StateRecord, installedBuild string) error {
	c := r.Compatibility
	if state.SchemaVersion < c.StateMin || state.SchemaVersion > c.StateMax || state.DataSchemaVersion < c.DataMin || state.DataSchemaVersion > c.DataMax {
		return fmt.Errorf("core release is incompatible with persistent State or Data")
	}
	minimum, err := ordering.ParseVersion(c.MinimumRelease)
	if err != nil {
		return err
	}
	installed, err := ordering.ParseVersion(installedBuild)
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
	_, verified, err := m.Selection(digest)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(verified, r) {
		return fmt.Errorf("frozen core release differs from coordinator")
	}
	if !recovery {
		if _, _, e := m.Selection(j.Previous.ManifestSHA256); e != nil {
			return e
		}
	}
	state, err := appliance.LoadState(a.Checkpoint.StatePath)
	if err != nil {
		return err
	}
	return validateCoreCompatibility(r, state, j.Previous.Release.Build)
}

// AuthorizeTarget checks the frozen, digest-bound target. The channel head is
// not consulted again: once a release was staged by its digest, a later
// channel change or an unreachable release host cannot invalidate it.
func (a NativeCoreAuthority) AuthorizeTarget(ctx context.Context, j CoreJournal, activation bool) error {
	return a.verify(ctx, j, false)
}

// Current channel changes do not implicitly prohibit recovery to the retained
// previous release. Its digest, compatibility and machine must still pass.
func (a NativeCoreAuthority) AuthorizePrevious(ctx context.Context, j CoreJournal) error {
	return a.verify(ctx, j, true)
}
