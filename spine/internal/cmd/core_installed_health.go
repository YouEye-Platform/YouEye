package cmd

import (
	"context"
	"errors"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var coreInstalledHealthStateRoot = systemupdate.CoreStatePath

// coreInstalledPayloadCheck walks one installed service tree. Tests replace it.
var coreInstalledPayloadCheck = systemupdate.VerifyCoreContainerPayload

// coreInstalledHealthMode decides how `youeye appliance health` checks one
// installed service tree. Health is a gate (its exit code must be 0 for first
// deploy, for the final health step of an update and of a recovery, for boot
// blessing and for an independent copy), so the rule is the same as everywhere:
// only a tree written by what is running now may fail it.
//
// The health command checks these trees only until first deployment is complete
// (collectApplianceHealth). On such a box the trees were written by first deploy
// moments ago, so the check is strict, also during the no-op request that
// accepts the installed release. Any other active request did not write a tree
// unless it replaced that member and reached its final health step; every other
// tree (reused, restored by recovery, same files under a promoted name, or left
// by an unfinished request) is recorded, never refused.
func coreInstalledHealthMode(journal *systemupdate.CoreJournal, role string) systemupdate.CorePayloadMode {
	if journal == nil || journal.NoOp {
		return systemupdate.CorePayloadStrict
	}
	switch journal.Phase {
	case "committed", "cancelled", "rolled-back":
		// No request is active: the trees are the fresh install's.
		return systemupdate.CorePayloadStrict
	case "applying":
	default:
		return systemupdate.CorePayloadRecord
	}
	if journal.MetadataOnly {
		return systemupdate.CorePayloadRecord
	}
	reached := false
	for _, step := range journal.Steps {
		if step.Name == "authenticated-health" && (step.State == "started" || step.State == "succeeded") {
			reached = true
		}
	}
	target, ok := journal.Target.Member(role)
	previous, okPrevious := journal.Previous.Release.Member(role)
	if reached && ok && okPrevious && target.Artifact.SHA256 != previous.Artifact.SHA256 {
		return systemupdate.CorePayloadStrict
	}
	return systemupdate.CorePayloadRecord
}

// A fresh initialized core can converge before the first-setup gate opens.
// Its selection and static indexes supersede per-component pins;
// the immutable host marker still has to match its own retained build identity.
// The summary carries what each tree held ("verified", "verified, 2 extra
// files", "modified (1 changed, 0 missing)"): all three pass for a tree that
// what is running now did not write.
func addCoreInstalledHealthChecks(image appliance.Manifest, add func(string, string, string)) bool {
	m := systemupdate.CoreManager{Root: coreInstalledHealthStateRoot}
	receipt, err := m.ReadReceipt()
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	fail := func() {
		add("installed core membership", "fail", "installed core payloads require reconciliation")
	}
	if err != nil {
		fail()
		return true
	}
	digest := receipt.ManifestSHA256
	j, err := m.Read()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		fail()
		return true
	}
	var journal *systemupdate.CoreJournal
	if err == nil {
		journal = &j
		if j.Phase == "applying" {
			for _, step := range j.Steps {
				if step.Name == "authenticated-health" && (step.State == "started" || step.State == "succeeded") {
					digest = j.ManifestSHA256
				}
			}
		}
	}
	_, release, err := m.Selection(digest)
	if err != nil || systemupdate.BindCoreImage(release, image) != nil {
		fail()
		return true
	}
	executable, err := coreInstalledExecutable()
	if err != nil || image.ReleaseSet == nil {
		fail()
		return true
	}
	if err := verifyRunningSpine(executable); err != nil {
		fail()
		return true
	}
	cfg := GetConfig()
	members := []systemupdate.CoreInstalledMember{}
	for _, member := range release.Members {
		if member.Role != "cp" && member.Role != "ui" {
			continue
		}
		index, err := m.LoadPayloadIndex(member.Artifact.SHA256)
		if err != nil {
			fail()
			return true
		}
		container, appDir := cfg.Deployment.Container.Name, cfg.Deployment.ControlPanel.AppDir
		if member.Role == "ui" {
			container, appDir = cfg.Deployment.UI.ContainerName, cfg.Deployment.UI.AppDir
		}
		found, err := coreInstalledPayloadCheck(context.Background(), container, appDir, index, coreInstalledHealthMode(journal, member.Role))
		var differs *systemupdate.CorePayloadDifferenceError
		if errors.As(err, &differs) {
			// Counts only: this summary is kept in health.json on State.
			add("installed core membership", "fail", "the "+member.Role+" files written by this installation or update are damaged: "+differs.Findings.Summary())
			return true
		}
		if err != nil {
			fail()
			return true
		}
		members = append(members, systemupdate.CoreInstalledMember{Role: member.Role, Summary: found.Summary(), Findings: found})
	}
	add("installed core membership", "pass", "accepted core selection matches immutable host and baked Spine; CP/UI static payloads: "+systemupdate.CoreInstalledSummary(members))
	return true
}
