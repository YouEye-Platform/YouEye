package installer

type applianceWriteStage string

const (
	stageVerifyInputs       applianceWriteStage = "verify-inputs"
	stagePartitionTarget    applianceWriteStage = "partition-target"
	stageFormatState        applianceWriteStage = "format-state"
	stageInitializeJournal  applianceWriteStage = "initialize-journal"
	stagePrepareData        applianceWriteStage = "prepare-data"
	stageWriteSystemA       applianceWriteStage = "write-system-a"
	stageWriteSystemB       applianceWriteStage = "write-system-b"
	stageWriteRecovery      applianceWriteStage = "write-recovery"
	stageInitializeState    applianceWriteStage = "initialize-state"
	stageInstallBootAssets  applianceWriteStage = "install-boot-assets"
	stageActivateSystemBoot applianceWriteStage = "activate-system-boot"
	stageVerifyInstall      applianceWriteStage = "verify-install"
)

type applianceWriteOperation struct {
	Stage       applianceWriteStage
	Target      string
	Description string
	Destructive bool
}

var applianceInstallStageOrder = []applianceWriteStage{
	stageVerifyInputs,
	stagePartitionTarget,
	stageFormatState,
	stageInitializeJournal,
	stagePrepareData,
	stageWriteSystemA,
	stageWriteSystemB,
	stageWriteRecovery,
	stageInitializeState,
	stageInstallBootAssets,
	stageActivateSystemBoot,
	stageVerifyInstall,
}

func applianceStageIndex(stage applianceWriteStage) int {
	for i, candidate := range applianceInstallStageOrder {
		if candidate == stage {
			return i
		}
	}
	return -1
}

func applianceWriteOperations(plan applianceInstallPlan) []applianceWriteOperation {
	return []applianceWriteOperation{
		{Stage: stageVerifyInputs, Description: "verify seed, manifest, signature, compatibility, disk sizing, and confirmation", Destructive: false},
		{Stage: stagePartitionTarget, Target: plan.TargetDiskPath, Description: "create the ESP, Recovery, System A/B, State, and YE-DATA partitions on one GPT drive", Destructive: true},
		{Stage: stageFormatState, Target: "YE-STATE", Description: "format state as ext4", Destructive: true},
		{Stage: stageInitializeJournal, Target: "YE-STATE", Description: "start the durable resumable install journal", Destructive: true},
		{Stage: stagePrepareData, Target: "YE-DATA", Description: "prepare the data partition for the appliance ZFS pool", Destructive: true},
		{Stage: stageWriteSystemA, Target: "YE-SYSTEM-A", Description: "write and verify the current root payload", Destructive: true},
		{Stage: stageWriteSystemB, Target: "YE-SYSTEM-B", Description: "write and verify the inactive root payload", Destructive: true},
		{Stage: stageWriteRecovery, Target: "YE-RECOVERY", Description: "write and verify the internal recovery artifact", Destructive: true},
		{Stage: stageInitializeState, Target: "YE-STATE", Description: "record layout, slot, and persistent identity metadata", Destructive: true},
		{Stage: stageInstallBootAssets, Target: "YE-ESP", Description: "install systemd-boot entries and UKIs", Destructive: true},
		{Stage: stageActivateSystemBoot, Target: "firmware", Description: "make System A the boot candidate only after images and state are durable", Destructive: true},
		{Stage: stageVerifyInstall, Description: "read back partition labels, payload hashes, state, and boot entries", Destructive: false},
	}
}
