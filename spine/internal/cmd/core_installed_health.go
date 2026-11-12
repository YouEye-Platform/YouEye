package cmd

import (
	"context"
	"errors"
	"os"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

var coreInstalledHealthStateRoot = systemupdate.CoreStatePath

// A fresh initialized core can converge before the first-setup gate opens.
// Its signed selection and static indexes supersede legacy per-component pins;
// the immutable host marker still has to match its own retained build identity.
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
	if err == nil && j.Phase == "applying" {
		for _, step := range j.Steps {
			if step.Name == "authenticated-health" && (step.State == "started" || step.State == "succeeded") {
				digest = j.ManifestSHA256
			}
		}
	}
	_, release, err := m.Selection(digest)
	if err != nil || systemupdate.BindCoreImage(release, image) != nil {
		fail()
		return true
	}
	executable, bootstrap, err := coreInstalledExecutable()
	if err != nil || image.ReleaseSet == nil {
		fail()
		return true
	}
	_ = bootstrap
	if err := verifyRunningSpine(executable); err != nil {
		fail()
		return true
	}
	cfg := GetConfig()
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
		if systemupdate.VerifyCoreContainerPayload(context.Background(), container, appDir, index) != nil {
			fail()
			return true
		}
	}
	add("installed core membership", "pass", "accepted core selection matches immutable host, baked Spine and exact CP/UI static payloads")
	return true
}
