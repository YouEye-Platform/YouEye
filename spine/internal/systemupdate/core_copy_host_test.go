package systemupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/youeye-platform/YouEye/releasecache"
)

func TestIndependentCopyHostIdentityAndCredentials(t *testing.T) {
	selection, root, trust := signedCopyFixture(t)
	m := CoreManager{Root: filepath.Join(root, "core")}
	source := CoreMachineIdentity{InstallIDRef: "install:source", DeviceIDRef: "device:source", ParentDiskID: "disk:source", StatePartUUID: "state", DataPartUUID: "data"}
	receipt, err := m.Initialize(context.Background(), selection, checksum(selection.Raw), trust, func(context.Context, releasecache.CoreRelease) (CoreMachineIdentity, string, error) {
		return source, "fixture", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	request := CoreCopyRequest{RequestID: "copy-host", SourceHardware: "smbios:11111111-1111-1111-1111-111111111111", DestinationHardware: "smbios:22222222-2222-2222-2222-222222222222", SourceReceiptSHA256: CoreReceiptDigest(receipt), ManifestSHA256: receipt.ManifestSHA256}
	guest := filepath.Join(root, "guest")
	for _, dir := range []string{"etc/ssh/sshd_config.d", "root/.ssh", "var/lib/crew-session-host-access/fixture", "proc/sys/kernel/random"} {
		if err = os.MkdirAll(filepath.Join(guest, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{"etc/systemd/network/20-youeye.network": copyDHCPNetwork, "etc/machine-id": "11111111111111111111111111111111\n", "etc/hostid": "old!", "proc/sys/kernel/random/boot_id": "33333333-3333-3333-3333-333333333333\n", "root/.ssh/id_ed25519": "fixture private material", "root/sample.txt": "ordinary test data", "var/lib/youeye-state/infra-copy/prior.names.json": "synthetic source Names authority", "etc/ssh/ssh_host_rsa_key": "source host key fixture", "var/lib/crew-session-host-access/fixture/key": "source Session fixture", "etc/ssh/crew_user_ca.pub": "source enrollment fixture"}
	for name, value := range files {
		if err = os.MkdirAll(filepath.Dir(filepath.Join(guest, name)), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(guest, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	actual := request.SourceHardware
	observe := func() (string, error) { return actual, nil }
	if _, err = m.PrepareIndependentCopyHost(request, guest, observe); err == nil {
		t.Fatal("host preparation reached source hardware")
	}
	actual = request.DestinationHardware
	if _, err = m.PrepareIndependentCopyHost(request, guest, observe); err == nil {
		t.Fatal("host preparation lacked native admission")
	}
	if err = m.BeginIndependentCopy(request, trust, observe); err != nil {
		t.Fatal(err)
	}
	first, err := m.PrepareIndependentCopyHost(request, guest, observe)
	if err != nil {
		t.Fatal(err)
	}
	if first.MachineID == "11111111111111111111111111111111" || first.SSHHostFingerprint == "" || !first.RebootRequired {
		t.Fatal("host identity not prepared")
	}
	again, err := m.PrepareIndependentCopyHost(request, guest, observe)
	if err != nil || again != first {
		t.Fatal("retry changed generated authority", err)
	}
	if _, err = m.VerifyIndependentCopyHost(request, guest, observe); err == nil {
		t.Fatal("prepared files mistaken for a later boot")
	}
	if err = os.WriteFile(filepath.Join(guest, "proc/sys/kernel/random/boot_id"), []byte("44444444-4444-4444-4444-444444444444\n"), 0600); err != nil {
		t.Fatal(err)
	}
	verified, err := m.VerifyIndependentCopyHost(request, guest, observe)
	if err != nil || verified.RebootRequired || verified.MachineID != first.MachineID || verified.SSHHostFingerprint != first.SSHHostFingerprint {
		t.Fatal("later boot identity not verified", err)
	}
	for _, name := range []string{"root/.ssh", "var/lib/crew-session-host-access", "var/lib/youeye-state/infra-copy", "etc/ssh/ssh_host_rsa_key", "etc/ssh/crew_user_ca.pub"} {
		if _, err = os.Lstat(filepath.Join(guest, name)); !os.IsNotExist(err) {
			t.Fatal("inherited machine authority remained", name)
		}
	}
	if raw, _ := os.ReadFile(filepath.Join(guest, "root/sample.txt")); string(raw) != "ordinary test data" {
		t.Fatal("copy removed ordinary data")
	}
	if raw, _ := os.ReadFile(filepath.Join(guest, "etc/machine-id")); string(raw) != first.MachineID+"\n" {
		t.Fatal("machine ID not written")
	}
	if err = os.WriteFile(filepath.Join(guest, "etc/machine-id"), []byte("33333333333333333333333333333333\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = m.PrepareIndependentCopyHost(request, guest, observe); err == nil {
		t.Fatal("retry replaced unrelated OS identity")
	}
}
