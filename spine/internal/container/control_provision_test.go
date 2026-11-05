package container

import (
	"os"
	"strings"
	"testing"
)

func TestControlPanelObservationReady(t *testing.T) {
	ready := controlPanelObservation{true, true, true, true, true}
	if !ready.ready() || !canContinueControlProvisioning(ready, false) {
		t.Fatal("complete deployment must be recognised as ready and continuable")
	}
}

func TestControlPanelObservationEmptyPartialCanContinue(t *testing.T) {
	empty := controlPanelObservation{Exists: true}
	if !empty.emptyPartial() || !canContinueControlProvisioning(empty, false) {
		t.Fatal("an empty installer-created container must be safe to continue")
	}
}

func TestControlPanelObservationAmbiguousPartialNeedsJournal(t *testing.T) {
	partial := controlPanelObservation{Exists: true, AppBundle: true}
	if canContinueControlProvisioning(partial, false) {
		t.Fatal("an unjournaled partial application must not be overwritten")
	}
	if !canContinueControlProvisioning(partial, true) {
		t.Fatal("a journal-owned partial application must be resumable")
	}
}

func TestControlPanelObservationCanRecoverMissingHostSecret(t *testing.T) {
	partial := controlPanelObservation{
		Exists:       true,
		AppBundle:    true,
		ControlUnit:  true,
		IdentityUnit: true,
	}
	if !canContinueControlProvisioning(partial, false) {
		t.Fatal("a complete service bundle with a recoverable unit credential must be adoptable")
	}
}

func TestCompleteControlPanelAdoptionRestoresProvenance(t *testing.T) {
	raw, err := os.ReadFile("control.go")
	if err != nil {
		t.Fatal(err)
	}
	ready := strings.Index(string(raw), "if observation.ready()")
	record := strings.Index(string(raw), "recordControlProvenance(cfg, containerName, appDir)")
	journal := strings.Index(string(raw), `writeControlProvisionJournal(containerName, "control-ready")`)
	if ready < 0 || record < ready || journal < record {
		t.Fatal("complete Control Panel adoption does not restore provenance before recording readiness")
	}
}
