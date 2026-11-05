package systemupdate

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/youeye-platform/YouEye/spine/internal/remoteaccess"
	"golang.org/x/crypto/ssh"
)

type copyHostIdentity struct {
	Schema          string          `json:"schema"`
	Request         CoreCopyRequest `json:"request"`
	SourceMachineID string          `json:"source_machine_id"`
	MachineID       string          `json:"machine_id"`
	SourceHostID    string          `json:"source_host_id"`
	HostID          string          `json:"host_id"`
	PreparedBootID  string          `json:"prepared_boot_id"`
	PrivateHostKey  string          `json:"private_host_key"`
	PublicHostKey   string          `json:"public_host_key"`
}
type CopyHostIdentityEvidence struct {
	MachineID          string `json:"machine_id"`
	SSHHostFingerprint string `json:"ssh_host_fingerprint"`
	RebootRequired     bool   `json:"reboot_required"`
}

// PrepareIndependentCopyHost changes only the admitted destination. root is the
// native filesystem root ("/" in production); isolated tests use their own tree.
// Private generated authority remains in a protected journal for interrupted
// replay. Prior copy private material is overwritten, never archived as authority.
func (m CoreManager) PrepareIndependentCopyHost(request CoreCopyRequest, root string, observeHardware func() (string, error)) (CopyHostIdentityEvidence, error) {
	var result CopyHostIdentityEvidence
	if request.Validate() != nil || observeHardware == nil || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return result, fmt.Errorf("exact native host copy context required")
	}
	actual, err := observeHardware()
	if err != nil || actual != request.DestinationHardware {
		return result, fmt.Errorf("copy host preparation reached different hardware")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return result, err
	}
	defer unlock()
	admitted, err := m.readCopy()
	if err != nil || admitted.Request != request || admitted.Phase != "verifying" {
		return result, fmt.Errorf("native destination copy admission required")
	}
	path := func(relative string) string { return filepath.Join(root, relative) }
	machinePath := path("etc/machine-id")
	machine, err := os.ReadFile(machinePath)
	if err != nil {
		return result, fmt.Errorf("source OS identity unavailable")
	}
	currentID := strings.TrimSpace(string(machine))
	hostID, err := os.ReadFile(path("etc/hostid"))
	if err != nil || len(hostID) != 4 {
		return result, fmt.Errorf("source persistent host identity unavailable")
	}
	bootID, err := os.ReadFile(path("proc/sys/kernel/random/boot_id"))
	if err != nil || !copyHardwarePattern.MatchString("smbios:"+strings.TrimSpace(string(bootID))) {
		return result, fmt.Errorf("current boot identity unavailable")
	}
	journalPath := filepath.Join(m.Root, "copy-host-identity.json")
	var journal copyHostIdentity
	raw, err := ReadCoreState(journalPath, 16384)
	if err == nil {
		if json.Unmarshal(raw, &journal) != nil || journal.Schema != "youeye.copy-host-identity.v1" || journal.Request.Validate() != nil {
			return result, fmt.Errorf("invalid copy host identity journal")
		}
		if journal.Request != request {
			var prior CoreCopyJournal
			priorRaw, e := ReadCoreState(filepath.Join(m.Root, "copy-history", journal.Request.RequestID+".json"), 4<<20)
			if e != nil || json.Unmarshal(priorRaw, &prior) != nil || prior.Phase != "committed" || prior.Request != journal.Request || prior.Request.DestinationHardware != request.SourceHardware || journal.MachineID != currentID {
				return result, fmt.Errorf("different copy owns host identity")
			}
			// The previous public copy receipt retains provenance. Its private host key
			// must not remain in the new machine's copy history.
			err = os.ErrNotExist
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		decoded, e := hex.DecodeString(currentID)
		if e != nil || len(decoded) != 16 {
			return result, fmt.Errorf("copy source machine ID is invalid")
		}
		id := make([]byte, 16)
		if _, err = rand.Read(id); err != nil {
			return result, err
		}
		newHostID := make([]byte, 4)
		if _, err = rand.Read(newHostID); err != nil {
			return result, err
		}
		public, private, e := ed25519.GenerateKey(rand.Reader)
		if e != nil {
			return result, e
		}
		block, e := ssh.MarshalPrivateKey(private, "independent YouEye copy")
		if e != nil {
			return result, e
		}
		authorized, e := ssh.NewPublicKey(public)
		if e != nil {
			return result, e
		}
		journal = copyHostIdentity{Schema: "youeye.copy-host-identity.v1", Request: request, SourceMachineID: currentID, MachineID: hex.EncodeToString(id), SourceHostID: hex.EncodeToString(hostID), HostID: hex.EncodeToString(newHostID), PreparedBootID: strings.TrimSpace(string(bootID)), PrivateHostKey: string(pem.EncodeToMemory(block)), PublicHostKey: string(ssh.MarshalAuthorizedKey(authorized))}
		raw, _ := json.Marshal(journal)
		if err = atomicWrite(journalPath, raw, 0600); err != nil {
			return result, err
		}
	} else if err != nil {
		return result, err
	}
	if currentID != journal.SourceMachineID && currentID != journal.MachineID {
		return result, fmt.Errorf("OS machine identity changed outside the copy")
	}
	newHostID, err := hex.DecodeString(journal.HostID)
	if err != nil || len(newHostID) != 4 || journal.HostID == journal.SourceHostID || (hex.EncodeToString(hostID) != journal.SourceHostID && hex.EncodeToString(hostID) != journal.HostID) || !copyHardwarePattern.MatchString("smbios:"+journal.PreparedBootID) {
		return result, fmt.Errorf("persistent host identity changed outside copy preparation")
	}
	signer, err := ssh.ParsePrivateKey([]byte(journal.PrivateHostKey))
	if err != nil || string(ssh.MarshalAuthorizedKey(signer.PublicKey())) != journal.PublicHostKey || len(journal.MachineID) != 32 || journal.MachineID == journal.SourceMachineID {
		return result, fmt.Errorf("copy host authority is inconsistent")
	}
	// Machine-id is an installer-owned bind-mounted file. Retain its inode so the
	// mounted path and persistent State file agree; a reboot settles cached users.
	file, err := os.OpenFile(machinePath, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return result, err
	}
	if info, e := file.Stat(); e != nil || !info.Mode().IsRegular() {
		file.Close()
		return result, fmt.Errorf("machine ID is not a regular file")
	}
	if _, err = file.WriteAt([]byte(journal.MachineID+"\n"), 0); err == nil {
		err = file.Truncate(33)
	}
	if err == nil {
		err = file.Sync()
	}
	file.Close()
	if err != nil {
		return result, err
	}
	sshDir := path("etc/ssh")
	if err = writeCopyBoundIdentity(path("etc/hostid"), newHostID); err != nil {
		return result, err
	}
	info, err := os.Lstat(sshDir)
	if err != nil || !info.IsDir() {
		return result, fmt.Errorf("persistent SSH directory unavailable")
	}
	if err = atomicWrite(filepath.Join(sshDir, "ssh_host_ed25519_key"), []byte(journal.PrivateHostKey), 0600); err != nil {
		return result, err
	}
	if err = atomicWrite(filepath.Join(sshDir, "ssh_host_ed25519_key.pub"), []byte(journal.PublicHostKey), 0644); err != nil {
		return result, err
	}
	for _, relative := range []string{"etc/ssh/ssh_host_rsa_key", "etc/ssh/ssh_host_rsa_key.pub", "etc/ssh/ssh_host_ecdsa_key", "etc/ssh/ssh_host_ecdsa_key.pub", "etc/ssh/crew_user_ca.pub", "etc/ssh/sshd_config.d/90-crew-user-ca.conf", "etc/ssh/crew_authorized_principals/root"} {
		if err = os.Remove(path(relative)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return result, err
		}
	}
	// Remove the inherited supported operator key enrollment through its owner.
	access := &remoteaccess.Manager{StorePath: path("var/lib/youeye-state/remote-access/authorized-keys.json"), AuditPath: path("var/lib/youeye-state/remote-access/audit.jsonl"), LivePath: path("root/.ssh/authorized_keys")}
	keys, err := access.List()
	if err != nil {
		return result, err
	}
	for _, key := range keys {
		if _, err = access.Delete(key.ID, true); err != nil {
			return result, err
		}
	}
	for _, relative := range []string{"root/.ssh", "var/lib/crew-session-host-access", "root/.youeye-infra", "root/.config/incus", "root/.config/lxc", "var/lib/youeye-state/infra-copy"} {
		directory := path(relative)
		info, e := os.Lstat(directory)
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil || !info.IsDir() {
			return result, fmt.Errorf("inherited machine credential directory is unsafe")
		}
		if err = os.RemoveAll(directory); err != nil {
			return result, err
		}
	}
	// The caller must stop/restart SSH and reboot before verification. This result
	// describes prepared files and does not claim a live daemon has reloaded them.
	if err = prepareIndependentCopyNetwork(root); err != nil {
		return result, err
	}
	return CopyHostIdentityEvidence{MachineID: journal.MachineID, SSHHostFingerprint: ssh.FingerprintSHA256(signer.PublicKey()), RebootRequired: true}, nil
}

func writeCopyBoundIdentity(path string, value []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("persistent host identity is not a regular bound file")
	}
	if _, err = file.WriteAt(value, 0); err != nil {
		return err
	}
	if err = file.Truncate(int64(len(value))); err != nil {
		return err
	}
	return file.Sync()
}

// VerifyIndependentCopyHost requires a later boot and independently reads the
// installed host identity/key files. Live SSH acceptance remains a provider
// probe; file evidence alone cannot assert which key a daemon is serving.
func (m CoreManager) VerifyIndependentCopyHost(request CoreCopyRequest, root string, observeHardware func() (string, error)) (CopyHostIdentityEvidence, error) {
	var result CopyHostIdentityEvidence
	if request.Validate() != nil || observeHardware == nil || !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return result, fmt.Errorf("exact host verification context required")
	}
	hardware, err := observeHardware()
	if err != nil || hardware != request.DestinationHardware {
		return result, fmt.Errorf("copy verification reached different hardware")
	}
	raw, err := ReadCoreState(filepath.Join(m.Root, "copy-host-identity.json"), 16384)
	if err != nil {
		return result, err
	}
	var j copyHostIdentity
	if json.Unmarshal(raw, &j) != nil || j.Schema != "youeye.copy-host-identity.v1" || j.Request != request {
		return result, fmt.Errorf("copy host receipt changed")
	}
	machine, err := os.ReadFile(filepath.Join(root, "etc/machine-id"))
	if err != nil || strings.TrimSpace(string(machine)) != j.MachineID || j.MachineID == j.SourceMachineID {
		return result, fmt.Errorf("copy machine identity differs")
	}
	host, err := os.ReadFile(filepath.Join(root, "etc/hostid"))
	if err != nil || len(host) != 4 || hex.EncodeToString(host) != j.HostID || j.HostID == j.SourceHostID {
		return result, fmt.Errorf("copy persistent host identity differs")
	}
	boot, err := os.ReadFile(filepath.Join(root, "proc/sys/kernel/random/boot_id"))
	if err != nil || !copyHardwarePattern.MatchString("smbios:"+strings.TrimSpace(string(boot))) || strings.TrimSpace(string(boot)) == j.PreparedBootID {
		return result, fmt.Errorf("copy identity requires a positively observed later boot")
	}
	key, err := ReadCoreState(filepath.Join(root, "etc/ssh/ssh_host_ed25519_key"), 16384)
	if err != nil {
		return result, err
	}
	signer, err := ssh.ParsePrivateKey(key)
	if err != nil || string(ssh.MarshalAuthorizedKey(signer.PublicKey())) != j.PublicHostKey {
		return result, fmt.Errorf("copy SSH host identity differs")
	}
	return CopyHostIdentityEvidence{MachineID: j.MachineID, SSHHostFingerprint: ssh.FingerprintSHA256(signer.PublicKey()), RebootRequired: false}, nil
}
