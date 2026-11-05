package installer

import (
	"errors"
	"strings"
	"testing"
)

func TestDiscoverApplianceTargetDiskSelectsBlankStableSerial(t *testing.T) {
	runner := &scriptedRunner{outputs: map[string]string{
		"lsblk --json --bytes --output NAME,PATH,TYPE,SIZE,MODEL,SERIAL,RM,RO,MOUNTPOINTS,FSTYPE,LABEL": `{
			"blockdevices":[
				{"name":"sda","path":"/dev/sda","type":"disk","size":137438953472,"model":"appliance","serial":"YEIDISK123","rm":false,"ro":false,"mountpoints":[],"fstype":"","label":""}
			]
		}`},
	}
	target, err := discoverApplianceTargetDisk(runner, applianceSeed{TargetSerial: "YEIDISK123"})
	if err != nil {
		t.Fatal(err)
	}
	if target.Path != "/dev/sda" || target.SizeBytes != 128*applianceGiB {
		t.Fatalf("unexpected drive: %+v", target)
	}
}

func TestDiscoverApplianceTargetDiskRequiresSeedIdentity(t *testing.T) {
	if _, err := discoverApplianceTargetDisk(&scriptedRunner{}, applianceSeed{}); err == nil {
		t.Fatal("expected missing target serial rejection")
	}
}

func TestDiscoverApplianceDisksHidesBootedInstallerMedia(t *testing.T) {
	raw := `{"blockdevices":[
		{"name":"sda","path":"/dev/sda","type":"disk","size":17179869184,"model":"USB","serial":"INSTALLER","rm":true,"ro":false,"mountpoints":[],"fstype":"","label":"","children":[
			{"name":"sda1","path":"/dev/sda1","type":"part","size":17179800000,"model":"","serial":"","rm":true,"ro":false,"mountpoints":["/run/live/medium"],"fstype":"iso9660","label":"YOUEYE_INSTALLER"}
		]},
		{"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","size":137438953472,"model":"Target","serial":"TARGET","rm":false,"ro":false,"mountpoints":[],"fstype":"","label":""}
	]}`
	disks, err := parseApplianceLSBLK(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != 1 || disks[0].Serial != "TARGET" {
		t.Fatalf("installer media was exposed as a target: %+v", disks)
	}
}

func TestDiscoverApplianceTargetDisksPreservesUnsafeSignalsForPlanRejection(t *testing.T) {
	runner := &scriptedRunner{outputs: map[string]string{
		"lsblk --json --bytes --output NAME,PATH,TYPE,SIZE,MODEL,SERIAL,RM,RO,MOUNTPOINTS,FSTYPE,LABEL": `{
			"blockdevices":[
				{"name":"sda","path":"/dev/sda","type":"disk","size":137438953472,"model":"appliance","serial":"TARGET","rm":false,"ro":false,"mountpoints":[],"fstype":"","label":"","children":[
					{"name":"sda6","path":"/dev/sda6","type":"part","size":107374182400,"model":"","serial":"","rm":false,"ro":false,"mountpoints":["/mnt/old"],"fstype":"zfs_member","label":"YE-DATA"}
				]}
			]
		}`},
	}
	target, err := discoverApplianceTargetDisk(runner, applianceSeed{TargetSerial: "TARGET"})
	if err != nil {
		t.Fatal(err)
	}
	if !target.Mounted || len(target.Signatures) == 0 {
		t.Fatalf("expected unsafe drive signals: %+v", target)
	}
	if _, err := planApplianceInstall(target, validApplianceArtifacts(8*applianceGiB)); err == nil {
		t.Fatal("expected plan rejection for mounted/nonblank drive")
	}
}

func TestApplianceProviderDiscoversSeededTargetsForPlanOnly(t *testing.T) {
	bundle := writeTestApplianceBundle(t)
	seedPath := writeTestSeed(t, bundle.manifestSHA, "YEIDISKTEST")
	runner := &scriptedRunner{outputs: map[string]string{
		"lsblk --json --bytes --output NAME,PATH,TYPE,SIZE,MODEL,SERIAL,RM,RO,MOUNTPOINTS,FSTYPE,LABEL": `{
			"blockdevices":[
				{"name":"vda","path":"/dev/vda","type":"disk","size":137438953472,"model":"appliance","serial":"YEIDISKTEST","rm":false,"ro":false,"mountpoints":[],"fstype":"","label":""}
			]
		}`},
	}
	cfg := installConfig{
		ApplianceSeedPath: seedPath,
		AppliancePlanOnly: true,
	}
	bundle.apply(&cfg)
	ch := make(chan engineMsg, 32)
	installApplianceWithRunner(cfg, ch, runner)
	close(ch)
	var final engineMsg
	for msg := range ch {
		final = msg
	}
	if final.Err != nil || final.ResultIP != "appliance-plan-only" {
		t.Fatalf("unexpected final message: %+v", final)
	}
}

type scriptedRunner struct {
	outputs map[string]string
	errs    map[string]error
	calls   []string
}

func (r *scriptedRunner) Run(name string, args ...string) (string, error) {
	call := name + " " + strings.Join(args, " ")
	r.calls = append(r.calls, call)
	if err := r.errs[call]; err != nil {
		return "", err
	}
	out, ok := r.outputs[call]
	if !ok {
		return "", errors.New("unexpected command: " + call)
	}
	return out, nil
}
