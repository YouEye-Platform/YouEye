package installer

import "testing"

func TestApplianceWriteOperationsKeepBootActivationLast(t *testing.T) {
	plan, err := planApplianceInstall(
		applianceDisk{Path: "/dev/vda", Serial: "target", SizeBytes: 128 * applianceGiB},
		validApplianceArtifacts(8*applianceGiB),
	)
	if err != nil {
		t.Fatal(err)
	}
	ops := applianceWriteOperations(plan)
	index := map[applianceWriteStage]int{}
	for i, op := range ops {
		index[op.Stage] = i
	}
	for _, before := range []applianceWriteStage{stageWriteSystemA, stageWriteSystemB, stageWriteRecovery, stageInitializeState, stageInstallBootAssets} {
		if index[before] >= index[stageActivateSystemBoot] {
			t.Fatalf("%s must occur before boot activation", before)
		}
	}
	if index[stageVerifyInstall] <= index[stageActivateSystemBoot] {
		t.Fatal("final verification must run after boot activation")
	}
}

func TestApplianceWriteOperationsDoNotMutateBeforeInputVerification(t *testing.T) {
	ops := applianceWriteOperations(applianceInstallPlan{TargetDiskPath: "/dev/vda"})
	if ops[0].Stage != stageVerifyInputs || ops[0].Destructive {
		t.Fatalf("first operation must be non-destructive verification: %+v", ops[0])
	}
	for i, op := range ops[1:] {
		if !op.Destructive && op.Stage != stageVerifyInstall {
			t.Fatalf("operation %d unexpectedly non-destructive before final verification: %+v", i+1, op)
		}
	}
}
