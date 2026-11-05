package storage

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
)

// TestApplianceSparseGPTZFSContract is opt-in because it needs root loop/ZFS
// access. It creates only a uniquely named sparse fixture pool and validates
// that pool creation/destruction never changes the parent GPT or YE-STATE.
func TestApplianceSparseGPTZFSContract(t *testing.T) {
	if os.Getenv("YOUEYE_APPLIANCE_INTEGRATION") != "1" {
		t.Skip("set YOUEYE_APPLIANCE_INTEGRATION=1 for privileged sparse GPT/ZFS acceptance")
	}
	if os.Geteuid() != 0 {
		t.Fatal("integration test must run as root")
	}
	for _, tool := range []string{"losetup", "sgdisk", "blockdev", "udevadm", "mkfs.ext4", "mount", "umount", "zpool", "zfs", "blkid", "lsblk", "sfdisk"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Fatalf("required tool %s: %v", tool, err)
		}
	}

	dir := t.TempDir()
	image := filepath.Join(dir, "appliance-disk.img")
	f, err := os.OpenFile(image, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(10 * GiB); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	loop := runIntegration(t, "losetup", "--find", "--show", "--partscan", image)
	defer exec.Command("losetup", "--detach", loop).Run()
	runIntegration(t, "sgdisk", "--zap-all", loop)
	runIntegration(t, "sgdisk", "--new=1:2048:+64M", "--typecode=1:8300", "--change-name=1:"+appliance.StatePartitionLabel, "--new=2:0:0", "--typecode=2:BF01", "--change-name=2:"+appliance.DataPartitionLabel, loop)
	runIntegration(t, "blockdev", "--rereadpt", loop)
	runIntegration(t, "udevadm", "settle")
	statePart, dataPart := loop+"p1", loop+"p2"
	if _, err := os.Stat(dataPart); err != nil {
		t.Fatalf("partition nodes unavailable: %v", err)
	}
	runIntegration(t, "mkfs.ext4", "-q", "-F", "-L", appliance.StatePartitionLabel, statePart)
	stateMount := filepath.Join(dir, "state")
	dataMount := filepath.Join(dir, "data")
	incusMount := filepath.Join(dir, "incus")
	for _, path := range []string{stateMount, dataMount, incusMount} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	runIntegration(t, "mount", statePart, stateMount)
	sentinel := filepath.Join(stateMount, "identity-sentinel")
	if err := os.WriteFile(sentinel, []byte("preserve-me\n"), 0600); err != nil {
		t.Fatal(err)
	}
	runIntegration(t, "umount", stateMount)
	gptBefore := runIntegration(t, "sfdisk", "--dump", loop)
	partUUID := runIntegration(t, "blkid", "-s", "PARTUUID", "-o", "value", dataPart)
	pool := fmt.Sprintf("yeitest%d", os.Getpid())
	poolCreated := false
	defer func() {
		if poolCreated {
			exec.Command("zpool", "destroy", "-f", pool).Run()
		}
	}()
	const compatibilityProfile = "openzfs-2.2"
	if err := createAppliancePartitionPoolNamed(pool, dataPart, partUUID, 1, compatibilityProfile, dataMount, incusMount); err != nil {
		t.Fatal(err)
	}
	poolCreated = true
	if err := validateAppliancePartitionPoolNamed(pool, dataPart, partUUID, 1, compatibilityProfile); err != nil {
		t.Fatal(err)
	}
	if got := DatasetProperty(pool, TopologyProperty); got != TopologyAppliancePartition {
		t.Fatalf("topology=%q", got)
	}
	if got := DatasetProperty(pool, "mountpoint"); got != "none" {
		t.Fatalf("pool root mountpoint=%q, want none", got)
	}
	if got := DatasetProperty(pool, "canmount"); got != "off" {
		t.Fatalf("pool root canmount=%q, want off", got)
	}
	if got := runIntegration(t, "zfs", "get", "-H", "-o", "value", "mountpoint", pool+"/data"); got != dataMount {
		t.Fatalf("data mountpoint=%q", got)
	}
	if got := runIntegration(t, "zfs", "get", "-H", "-o", "value", "mountpoint", pool+"/incus-state"); got != incusMount {
		t.Fatalf("Incus state mountpoint=%q", got)
	}
	members := PoolMemberDevices(pool)
	if len(members) != 1 || canonicalPath(members[0]) != canonicalPath(dataPart) {
		t.Fatalf("pool members=%v want %s", members, dataPart)
	}
	if canonicalPath(members[0]) == canonicalPath(loop) {
		t.Fatalf("parent whole disk became a pool member")
	}
	runIntegration(t, "zpool", "destroy", "-f", pool)
	poolCreated = false
	runIntegration(t, "blockdev", "--rereadpt", loop)
	runIntegration(t, "udevadm", "settle")
	if after := runIntegration(t, "sfdisk", "--dump", loop); after != gptBefore {
		t.Fatalf("parent GPT changed\nbefore:\n%s\nafter:\n%s", gptBefore, after)
	}
	runIntegration(t, "mount", statePart, stateMount)
	defer exec.Command("umount", stateMount).Run()
	content, err := os.ReadFile(sentinel)
	if err != nil || string(content) != "preserve-me\n" {
		t.Fatalf("YE-STATE sentinel changed: %q %v", content, err)
	}
}

func runIntegration(t *testing.T, name string, args ...string) string {
	t.Helper()
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out))
}
