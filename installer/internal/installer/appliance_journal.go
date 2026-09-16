package installer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const applianceInstallJournalSchema = "youeye.appliance.install-journal.v3"

type applianceInstallJournal struct {
	Schema         string              `json:"schema"`
	Operation      string              `json:"operation"`
	TransactionID  string              `json:"transaction_id"`
	ManifestSHA256 string              `json:"manifest_sha256"`
	ImageVersion   string              `json:"image_version"`
	Stage          applianceWriteStage `json:"stage"`
	TargetDisk     string              `json:"target_disk"`
	TargetSerial   string              `json:"target_serial"`
}

func inspectApplianceInstallJournal(runner applianceCommandRunner, targetDisk applianceDisk) (*applianceInstallJournal, error) {
	state := partitionPath(targetDisk.Path, 5)
	script := `set -eu
state="$1"
mountpoint="$2"
mkdir -p "$mountpoint"
umount "$mountpoint" 2>/dev/null || true
if ! mount -o ro,nodev,nosuid "$state" "$mountpoint" 2>/dev/null; then
  exit 0
fi
trap 'umount "$mountpoint" 2>/dev/null || true' EXIT
if [ -f "$mountpoint/installer/install-journal.json" ]; then
  cat "$mountpoint/installer/install-journal.json"
fi`
	out, err := runner.Run("sh", "-c", script, "youeye-read-install-journal", state, "/run/youeye-appliance/resume-state")
	if err != nil {
		return nil, fmt.Errorf("inspect appliance install journal: %w", err)
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	journal, err := parseApplianceInstallJournal([]byte(out))
	if err != nil {
		return nil, err
	}
	return &journal, nil
}

func parseApplianceInstallJournal(raw []byte) (applianceInstallJournal, error) {
	var journal applianceInstallJournal
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&journal); err != nil {
		return journal, fmt.Errorf("decode appliance install journal: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return journal, fmt.Errorf("decode appliance install journal: trailing JSON value")
	}
	if journal.Schema != applianceInstallJournalSchema {
		return journal, fmt.Errorf("unsupported appliance install journal schema %q", journal.Schema)
	}
	if journal.Operation != "erase-install" && journal.Operation != "preserve-reinstall" {
		return journal, fmt.Errorf("appliance install journal operation %q is invalid", journal.Operation)
	}
	if !validSHA256Hex(journal.ManifestSHA256) || strings.TrimSpace(journal.ImageVersion) == "" {
		return journal, fmt.Errorf("appliance install journal identity is incomplete")
	}
	if !validApplianceTransactionID(journal.TransactionID) {
		return journal, fmt.Errorf("appliance install journal transaction identity is invalid")
	}
	if applianceStageIndex(journal.Stage) < applianceStageIndex(stageInitializeJournal) {
		return journal, fmt.Errorf("appliance install journal stage %q is not resumable", journal.Stage)
	}
	if strings.TrimSpace(journal.TargetDisk) == "" || strings.TrimSpace(journal.TargetSerial) == "" {
		return journal, fmt.Errorf("appliance install journal target identity is incomplete")
	}
	return journal, nil
}

func (j applianceInstallJournal) matches(bundle verifiedApplianceBundle, targetDisk applianceDisk, transactionID string) bool {
	return j.TransactionID == transactionID &&
		j.ManifestSHA256 == bundle.ManifestSHA256 &&
		j.ImageVersion == bundle.Manifest.ImageVersion &&
		strings.EqualFold(strings.TrimSpace(j.TargetSerial), strings.TrimSpace(targetDisk.Serial))
}

func applianceResumeCommandPlan(commands []applianceCommand, completed applianceWriteStage, plan applianceInstallPlan, assets applianceImageAssets) ([]applianceCommand, error) {
	completedIndex := applianceStageIndex(completed)
	if completedIndex < applianceStageIndex(stageInitializeJournal) {
		return nil, fmt.Errorf("appliance stage %q is not resumable", completed)
	}
	state := partitionPath(plan.TargetDiskPath, 5)
	esp := partitionPath(plan.TargetDiskPath, 1)
	resume := []applianceCommand{
		{Stage: stageVerifyInputs, Name: "sh", Args: []string{"-c", `for target in "$@"; do umount "$target" 2>/dev/null || true; done`, "youeye-resume-cleanup", systemMount, espMount, stateMount}},
		{Stage: stageVerifyInputs, Name: "mkdir", Args: []string{"-p", systemMount, espMount, stateMount}},
	}
	for _, command := range commands {
		if command.Stage == stageVerifyInputs {
			resume = append(resume, command)
		}
	}
	resume = append(resume,
		applianceCommand{Stage: stageVerifyInputs, Name: "mount", Args: []string{state, stateMount}},
		applianceCommand{Stage: stageVerifyInputs, Name: "test", Args: []string{"-f", installJournalPath}},
		applianceCommand{Stage: stageVerifyInputs, Name: "sgdisk", Args: []string{"--verify", plan.TargetDiskPath}},
	)
	if completedIndex >= applianceStageIndex(stageWriteSystemA) {
		resume = append(resume, payloadReadbackCommand(stageVerifyInputs, assets.RootPayload, partitionPath(plan.TargetDiskPath, 3)))
	}
	if completedIndex >= applianceStageIndex(stageWriteSystemB) {
		resume = append(resume, payloadReadbackCommand(stageVerifyInputs, assets.RootPayload, partitionPath(plan.TargetDiskPath, 4)))
	}
	if completedIndex >= applianceStageIndex(stageWriteRecovery) {
		resume = append(resume, payloadReadbackCommand(stageVerifyInputs, assets.RecoveryPayload, partitionPath(plan.TargetDiskPath, 2)))
	}
	if completedIndex >= applianceStageIndex(stageInitializeState) {
		resume = append(resume,
			applianceCommand{Stage: stageVerifyInputs, Name: "test", Args: []string{"-s", stateMount + "/etc/machine-id"}},
			applianceCommand{Stage: stageVerifyInputs, Name: "test", Args: []string{"-f", stateMount + "/etc/systemd/network/20-youeye.network"}},
		)
	}
	if completedIndex >= applianceStageIndex(stageInstallBootAssets) {
		resume = append(resume,
			applianceCommand{Stage: stageVerifyInputs, Name: "cmp", Args: []string{"-s", assets.SystemAUKIPath, stateBootBackup + "/system-a.efi"}},
			applianceCommand{Stage: stageVerifyInputs, Name: "cmp", Args: []string{"-s", assets.SystemBUKIPath, stateBootBackup + "/system-b.efi"}},
			applianceCommand{Stage: stageVerifyInputs, Name: "cmp", Args: []string{"-s", assets.RecoveryUKIPath, stateBootBackup + "/recovery.efi"}},
			applianceCommand{Stage: stageVerifyInputs, Name: "mount", Args: []string{esp, espMount}},
			applianceCommand{Stage: stageVerifyInputs, Name: "cmp", Args: []string{"-s", assets.SystemAUKIPath, espVendorDir + "/youeye-system-a.efi"}},
			applianceCommand{Stage: stageVerifyInputs, Name: "cmp", Args: []string{"-s", assets.SystemBUKIPath, espVendorDir + "/youeye-system-b.efi"}},
			applianceCommand{Stage: stageVerifyInputs, Name: "cmp", Args: []string{"-s", assets.RecoveryUKIPath, espVendorDir + "/youeye-recovery.efi"}},
			applianceCommand{Stage: stageVerifyInputs, Name: "umount", Args: []string{espMount}},
		)
	}
	for _, command := range commands {
		if applianceStageIndex(command.Stage) > completedIndex {
			resume = append(resume, command)
		}
	}
	if completedIndex >= applianceStageIndex(stageVerifyInstall) {
		resume = append(resume,
			applianceCommand{Stage: stageVerifyInstall, Name: "sync", Args: []string{}},
			applianceCommand{Stage: stageVerifyInstall, Name: "umount", Args: []string{stateMount}},
		)
	}
	return resume, nil
}
