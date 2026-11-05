package installer

import "testing"

func TestPlanApplianceInstallUsesOneDriveABLayout(t *testing.T) {
	plan, err := planApplianceInstall(
		applianceDisk{Path: "/dev/vda", Serial: "target-1234", SizeBytes: 128 * applianceGiB},
		validApplianceArtifacts(8*applianceGiB),
	)
	if err != nil {
		t.Fatal(err)
	}
	if plan.TargetDiskPath != "/dev/vda" || plan.TargetSerial != "target-1234" {
		t.Fatalf("unexpected drive: %+v", plan)
	}
	if plan.RootSlotBytes != 8*applianceGiB {
		t.Fatalf("root slot=%d want 8 GiB", plan.RootSlotBytes)
	}
	wantLabels := []string{"YE-ESP", "YE-RECOVERY", "YE-SYSTEM-A", "YE-SYSTEM-B", "YE-STATE", "YE-DATA"}
	if len(plan.Partitions) != len(wantLabels) {
		t.Fatalf("partitions=%d want %d", len(plan.Partitions), len(wantLabels))
	}
	for i, want := range wantLabels {
		if plan.Partitions[i].Label != want {
			t.Fatalf("partition %d label=%q want %q", i, plan.Partitions[i].Label, want)
		}
	}
}

func TestPlanApplianceInstallRejectsUnsafeTargetsBeforeDiskMutation(t *testing.T) {
	target := applianceDisk{Path: "/dev/vda", Serial: "target", SizeBytes: 128 * applianceGiB}
	artifacts := validApplianceArtifacts(8 * applianceGiB)
	cases := []struct {
		name      string
		target    applianceDisk
		artifacts applianceArtifactSet
	}{
		{name: "mounted target", target: withMounted(target), artifacts: artifacts},
		{name: "read-only target", target: withReadOnly(target), artifacts: artifacts},
		{name: "nonblank target", target: withSignatures(target, "zfs_member"), artifacts: artifacts},
		{name: "installer media", target: func() applianceDisk { d := target; d.InstallerMedia = true; return d }(), artifacts: artifacts},
		{name: "undersized target", target: applianceDisk{Path: "/dev/vda", Serial: "target", SizeBytes: 31 * applianceGiB}, artifacts: artifacts},
		{name: "unverified", target: target, artifacts: applianceArtifactSet{RootPayloadBytes: 8 * applianceGiB, ManifestSHA256: validSHA256(), Verified: false, Compatible: true}},
		{name: "bad digest", target: target, artifacts: applianceArtifactSet{RootPayloadBytes: 8 * applianceGiB, ManifestSHA256: "not-a-sha", Verified: true, Compatible: true}},
		{name: "incompatible", target: target, artifacts: applianceArtifactSet{RootPayloadBytes: 8 * applianceGiB, ManifestSHA256: validSHA256(), Verified: true, Compatible: false}},
		{name: "oversized root", target: target, artifacts: validApplianceArtifacts(8*applianceGiB + 1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := planApplianceInstall(tc.target, tc.artifacts); err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
}

func TestPlanApplianceInstallAcceptsThirtyTwoGiBWithSevenGiBData(t *testing.T) {
	plan, err := planApplianceInstall(
		applianceDisk{Path: "/dev/vda", Serial: "trial", SizeBytes: 32 * applianceGiB},
		validApplianceArtifacts(8*applianceGiB),
	)
	if err != nil {
		t.Fatal(err)
	}
	if plan.DataBytes != 7*applianceGiB {
		t.Fatalf("32 GiB plan data = %s, want 7 GiB", formatBytes(plan.DataBytes))
	}
	if len(plan.Partitions) != 6 || plan.Partitions[2].Label != "YE-SYSTEM-A" || plan.Partitions[3].Label != "YE-SYSTEM-B" {
		t.Fatalf("32 GiB plan lost mandatory A/B layout: %+v", plan.Partitions)
	}
}

func TestPlanApplianceInstallAcceptsFiftyGiBAdvancedTarget(t *testing.T) {
	plan, err := planApplianceInstall(
		applianceDisk{Path: "/dev/vda", Serial: "advanced-50", SizeBytes: 50 * applianceGiB},
		validApplianceArtifacts(8*applianceGiB),
	)
	if err != nil {
		t.Fatal(err)
	}
	if plan.DataBytes != 25*applianceGiB {
		t.Fatalf("50 GiB plan data = %s, want 25 GiB", formatBytes(plan.DataBytes))
	}
	if len(plan.Partitions) != 6 || plan.Partitions[2].Label != "YE-SYSTEM-A" || plan.Partitions[3].Label != "YE-SYSTEM-B" {
		t.Fatalf("50 GiB plan lost mandatory A/B layout: %+v", plan.Partitions)
	}
}

func TestApplianceRootSlotSizingIsFixedAndRejectsOversizedImages(t *testing.T) {
	if got, err := applianceRootSlotSize(1 * applianceGiB); err != nil || got != 8*applianceGiB {
		t.Fatalf("small payload root slot=%d err=%v want 8 GiB", got, err)
	}
	if got, err := applianceRootSlotSize(8 * applianceGiB); err != nil || got != 8*applianceGiB {
		t.Fatalf("full payload root slot=%d err=%v want 8 GiB", got, err)
	}
	if _, err := applianceRootSlotSize(8*applianceGiB + 1); err == nil {
		t.Fatal("expected oversized root rejection")
	}
}

func validApplianceArtifacts(rootBytes int64) applianceArtifactSet {
	return applianceArtifactSet{RootPayloadBytes: rootBytes, ManifestSHA256: validSHA256(), Verified: true, Compatible: true}
}

func validSHA256() string {
	return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

func withMounted(d applianceDisk) applianceDisk {
	d.Mounted = true
	return d
}

func withReadOnly(d applianceDisk) applianceDisk {
	d.ReadOnly = true
	return d
}

func withSignatures(d applianceDisk, signatures ...string) applianceDisk {
	d.Signatures = signatures
	return d
}
