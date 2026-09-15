package installer

import (
	"fmt"
	"os"
	"strings"

	"github.com/youeye-platform/YouEye/appliance/ordering"
)

func installAppliance(cfg installConfig, ch chan<- engineMsg) {
	installApplianceWithRunner(cfg, ch, shellApplianceRunner{})
}

func installApplianceWithRunner(cfg installConfig, ch chan<- engineMsg, runner applianceCommandRunner) {
	send(ch, "Verify appliance release", "Checking manifest signature and artifact identities", 0.05)
	bundle, err := verifyApplianceBundle(cfg.ApplianceManifestPath, cfg.ApplianceSignaturePath, cfg.ApplianceTrustKeyPath)
	if err != nil {
		sendErr(ch, err)
		return
	}
	root := bundle.Assets["system-root"]
	recovery := bundle.Assets["internal-recovery"]
	systemAUKI := bundle.Assets["system-a-uki"]
	systemBUKI := bundle.Assets["system-b-uki"]
	recoveryUKI := bundle.Assets["recovery-uki"]
	rootBytes := root.Manifest.UncompressedSizeBytes
	if rootBytes == 0 {
		rootBytes = root.Manifest.SizeBytes
	}

	input, err := loadApplianceInstallInput(cfg)
	if err != nil {
		sendErr(ch, err)
		return
	}
	if input.ManifestSHA256 != "" && input.ManifestSHA256 != bundle.ManifestSHA256 {
		sendErr(ch, fmt.Errorf("automation seed manifest identity does not match the verified appliance bundle"))
		return
	}
	if input.Operation == "cancel" {
		send(ch, "Installation cancelled", "No disks were changed", 1.0)
		sendDone(ch, "appliance-cancelled")
		return
	}
	send(ch, "Discover target disks", input.Description, 0.20)
	targetDisk, err := applianceTargetDisk(cfg, input, runner)
	if err != nil {
		sendErr(ch, err)
		return
	}
	journal, journalErr := inspectApplianceInstallJournal(runner, targetDisk)
	resuming := input.Operation == "resume"
	preserving := input.Operation == "preserve-reinstall"
	if resuming {
		if journalErr != nil {
			sendErr(ch, journalErr)
			return
		}
		if journal == nil || !journal.matches(bundle, targetDisk, input.TransactionID) {
			sendErr(ch, fmt.Errorf("resume requires the exact matching transaction, manifest, image, and installation drive"))
			return
		}
		preserving = journal.Operation == "preserve-reinstall"
	}
	allowNonBlank := input.EraseConfirmed || resuming || preserving
	plan, err := planApplianceInstall(targetDisk, applianceArtifactSet{
		RootPayloadBytes: rootBytes,
		ManifestSHA256:   bundle.ManifestSHA256,
		Verified:         true,
		Compatible:       true,
		AllowNonBlank:    allowNonBlank,
	})
	if err != nil {
		sendErr(ch, err)
		return
	}
	send(ch, "Plan appliance layout", fmt.Sprintf("%s -> ESP, Recovery, System A/B, State, and YE-DATA; manifest %s", plan.TargetDiskPath, bundle.ManifestSHA256[:12]), 0.45)
	if cfg.AppliancePlanOnly {
		send(ch, "Plan-only complete", "No disk writes were performed", 1.0)
		sendDone(ch, "appliance-plan-only")
		return
	}
	answerPath := input.AnswerPath
	if answerPath == "" {
		answerPath, err = writeRuntimeApplianceAnswer(input, targetDisk)
		if err != nil {
			sendErr(ch, err)
			return
		}
		defer os.Remove(answerPath)
	}
	assets := applianceImageAssets{
		Operation:       "erase-install",
		RootPayload:     appliancePayloadFromVerified(root),
		RecoveryPayload: appliancePayloadFromVerified(recovery),
		SystemAUKIPath:  systemAUKI.Path,
		SystemBUKIPath:  systemBUKI.Path,
		RecoveryUKIPath: recoveryUKI.Path,
		ManifestPath:    cfg.ApplianceManifestPath,
		SignaturePath:   cfg.ApplianceSignaturePath,
		ManifestSHA256:  bundle.ManifestSHA256,
		ImageVersion:    bundle.Manifest.ImageVersion,
		TransactionID:   input.TransactionID,
		Network:         input.Network,
		AnswerPath:      answerPath,
		AuthorizedKeys:  input.AuthorizedKeys,
	}
	if preserving {
		assets.Operation = "preserve-reinstall"
	}
	if preserving && !resuming {
		installed, inspectErr := inspectInstalledApplianceIdentity(runner, targetDisk, cfg.ApplianceTrustKeyPath)
		if inspectErr != nil || installed == nil {
			if inspectErr == nil {
				inspectErr = fmt.Errorf("no trusted installed appliance identity was found")
			}
			sendErr(ch, fmt.Errorf("preserve reinstall preflight: %w", inspectErr))
			return
		}
		if err := ordering.RequireUpgradeIdentity(installed.ImageVersion, bundle.Manifest.ImageVersion); err != nil {
			sendErr(ch, fmt.Errorf("preserve reinstall requires a strictly newer signed appliance: %w", err))
			return
		}
	}
	var commands []applianceCommand
	if preserving {
		commands, err = appliancePreserveCommandPlan(plan, assets, bundle.Manifest)
	} else {
		commands, err = applianceCommandPlan(plan, assets)
	}
	if err != nil {
		sendErr(ch, err)
		return
	}
	if resuming {
		commands, err = applianceResumeCommandPlan(commands, journal.Stage, plan, assets)
		if err != nil {
			sendErr(ch, err)
			return
		}
		send(ch, "Resume appliance install", fmt.Sprintf("Verified matching journal through %s; completed writes will be read back before continuing", journal.Stage), 0.48)
	} else if input.EraseConfirmed && len(nonBlankSignatures(targetDisk.Signatures)) > 0 {
		send(ch, "Restart appliance install", "The confirmed full erase starts a new installation transaction", 0.48)
	} else if preserving {
		send(ch, "Preserve settings and data", "The verified appliance layout, State, and YE-DATA will be retained", 0.48)
	}
	if !resuming {
		currentTarget, err := discoverApplianceTargetDisk(runner, applianceSeed{TargetSerial: input.TargetSerial})
		if err != nil {
			sendErr(ch, fmt.Errorf("re-discover installation drive before writing: %w", err))
			return
		}
		if err := verifyApplianceTargetUnchanged(targetDisk, currentTarget); err != nil {
			sendErr(ch, err)
			return
		}
	}
	detail := "Starting destructive disk imaging sequence"
	if preserving {
		detail = "Replacing verified System A/B, Recovery, and boot assets while preserving State and YE-DATA"
	}
	send(ch, "Install appliance", detail, 0.50)
	err = executeApplianceCommands(commands, runner, func(command applianceCommand) {
		send(ch, string(command.Stage), applianceCommandProgressDetail(command), applianceStageProgress(command.Stage))
	})
	if err != nil {
		sendErr(ch, err)
		return
	}
	complete := "System A/B, recovery, State, YE-DATA, and UEFI boot assets verified"
	if preserving {
		complete = "System A/B, recovery, and UEFI boot assets verified; State and YE-DATA preserved"
	}
	send(ch, "Install complete", complete, 1.0)
	sendDone(ch, "appliance-installed")
}

type applianceInstallInput struct {
	Operation      string
	TransactionID  string
	TargetSerial   string
	EraseConfirmed bool
	Network        applianceAnswerNetwork
	AuthorizedKeys []string
	ReleasePolicy  applianceReleasePolicy
	Development    developmentAccessPolicy
	AnswerPath     string
	ManifestSHA256 string
	Description    string
}

func loadApplianceInstallInput(cfg installConfig) (applianceInstallInput, error) {
	if cfg.ApplianceAnswerPath != "" {
		raw, err := os.ReadFile(cfg.ApplianceAnswerPath)
		if err != nil {
			return applianceInstallInput{}, fmt.Errorf("read appliance answer: %w", err)
		}
		answer, err := parseApplianceAnswer(raw)
		if err != nil {
			return applianceInstallInput{}, err
		}
		policy, development := answer.ReleasePolicy, answer.Development
		if answer.Schema == applianceAnswerLegacySchema {
			policy, development = defaultApplianceReleasePolicy(), defaultDevelopmentAccessPolicy()
		}
		return applianceInstallInput{
			Operation: answer.Operation, TransactionID: answer.TransactionID,
			TargetSerial: answer.TargetSerial, EraseConfirmed: answer.EraseConfirmed,
			Network: answer.Network, ReleasePolicy: policy, Development: development,
			AuthorizedKeys: answer.AuthorizedKeys, AnswerPath: cfg.ApplianceAnswerPath,
			Description: "Reading standalone appliance answer",
		}, nil
	}
	if cfg.ApplianceSeedPath != "" {
		raw, err := os.ReadFile(cfg.ApplianceSeedPath)
		if err != nil {
			return applianceInstallInput{}, fmt.Errorf("read appliance seed: %w", err)
		}
		seed, err := parseApplianceSeed(raw)
		if err != nil {
			return applianceInstallInput{}, err
		}
		transactionID := seed.TransactionID
		if transactionID == "" && (seed.Operation == "install" || seed.Operation == "reinstall") {
			transactionID, err = newApplianceTransactionID()
			if err != nil {
				return applianceInstallInput{}, err
			}
		}
		return applianceInstallInput{
			Operation: seed.Operation, TransactionID: transactionID, TargetSerial: seed.TargetSerial, ManifestSHA256: seed.ManifestSHA256,
			EraseConfirmed: seed.Operation == "reinstall",
			Network:        applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: defaultApplianceReleasePolicy(), Development: defaultDevelopmentAccessPolicy(),
			Description: "Reading Infra automation seed for rig " + seed.RigID,
		}, nil
	}
	if cfg.ApplianceTargetDisk != "" {
		transactionID, err := newApplianceTransactionID()
		if err != nil {
			return applianceInstallInput{}, err
		}
		return applianceInstallInput{Operation: "install", TransactionID: transactionID, Network: applianceAnswerNetwork{Mode: "dhcp"}, ReleasePolicy: defaultApplianceReleasePolicy(), Development: defaultDevelopmentAccessPolicy(), Description: "Using an explicitly selected installation drive"}, nil
	}
	return applianceInstallInput{}, fmt.Errorf("install requires --answer, --seed, or an explicitly selected installation drive")
}

func writeRuntimeApplianceAnswer(input applianceInstallInput, target applianceDisk) (string, error) {
	tmp, err := os.CreateTemp("", ".youeye-runtime-answer-*.json")
	if err != nil {
		return "", fmt.Errorf("create protected runtime answer: %w", err)
	}
	path := tmp.Name()
	if err := tmp.Close(); err != nil {
		os.Remove(path)
		return "", fmt.Errorf("close protected runtime answer: %w", err)
	}
	if err := os.Remove(path); err != nil {
		return "", fmt.Errorf("prepare protected runtime answer: %w", err)
	}
	operation := input.Operation
	eraseConfirmed := input.EraseConfirmed
	if operation == "install" || operation == "reinstall" || operation == "resume" {
		operation = "erase-install"
		eraseConfirmed = true
	}
	answer := applianceAnswer{
		Schema: applianceAnswerSchema, Operation: operation, TransactionID: input.TransactionID,
		TargetSerial: target.Serial, EraseConfirmed: eraseConfirmed,
		Network: input.Network, ReleasePolicy: input.ReleasePolicy, Development: input.Development,
		AuthorizedKeys: input.AuthorizedKeys,
	}
	if err := writeApplianceAnswerFile(path, answer); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

func verifyApplianceTargetUnchanged(selected, current applianceDisk) error {
	if selected.Path != current.Path || !strings.EqualFold(strings.TrimSpace(selected.Serial), strings.TrimSpace(current.Serial)) || selected.SizeBytes != current.SizeBytes {
		return fmt.Errorf("installation drive identity changed after confirmation; no disk was changed")
	}
	if err := validateApplianceTargetDisk("installation drive", current, true); err != nil {
		return fmt.Errorf("installation drive became unsafe after confirmation: %w", err)
	}
	return nil
}

func appliancePayloadFromVerified(asset verifiedApplianceAsset) appliancePayloadAsset {
	sha256 := asset.Manifest.SHA256
	size := asset.Manifest.SizeBytes
	if asset.Manifest.Compression != "" {
		sha256 = asset.Manifest.UncompressedSHA256
		size = asset.Manifest.UncompressedSizeBytes
	}
	return appliancePayloadAsset{
		Path: asset.Path, Compression: asset.Manifest.Compression,
		SHA256: sha256, SizeBytes: size,
	}
}

func applianceTargetDisk(cfg installConfig, input applianceInstallInput, runner applianceCommandRunner) (applianceDisk, error) {
	if cfg.ApplianceTargetDisk != "" || cfg.ApplianceTargetDiskGB > 0 {
		if !cfg.AppliancePlanOnly {
			return applianceDisk{}, fmt.Errorf("an explicit installation-drive path is available only with --plan-only; effectful installs require live serial discovery")
		}
		return applianceDisk{
			Path: cfg.ApplianceTargetDisk, Serial: input.TargetSerial,
			SizeBytes: int64(cfg.ApplianceTargetDiskGB) * applianceGiB,
		}, nil
	}
	return discoverApplianceTargetDisk(runner, applianceSeed{TargetSerial: input.TargetSerial})
}

func applianceCommandProgressDetail(command applianceCommand) string {
	if command.Name == "sh" || command.Name == "bash" {
		return command.Name + " [redacted script arguments]"
	}
	return command.Name + " " + strings.Join(command.Args, " ")
}

func applianceStageProgress(stage applianceWriteStage) float64 {
	switch stage {
	case stageVerifyInputs:
		return 0.50
	case stagePartitionTarget:
		return 0.56
	case stageFormatState:
		return 0.66
	case stageInitializeJournal:
		return 0.68
	case stagePrepareData:
		return 0.72
	case stageWriteSystemA:
		return 0.78
	case stageWriteSystemB:
		return 0.84
	case stageWriteRecovery:
		return 0.89
	case stageInitializeState:
		return 0.92
	case stageInstallBootAssets:
		return 0.95
	case stageActivateSystemBoot:
		return 0.98
	default:
		return 0.99
	}
}
