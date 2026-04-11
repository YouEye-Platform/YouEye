package util

import (
	"os"
	"path/filepath"
	"strings"
)

// HostIPFile is the persistence path for the last-known host primary IP.
// Spine writes it after a successful deploy and after a successful host-IP
// migration. The host-ip-check routine compares it against the live
// GetPrimaryIP() at every spine api serve startup to detect IP changes.
const HostIPFile = "/var/lib/youeye/.host_ip"

// ReadStoredHostIP returns the persisted host IP, or "" if the file does
// not exist. Any other read error is returned to the caller.
func ReadStoredHostIP() (string, error) {
	data, err := os.ReadFile(HostIPFile)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// WriteStoredHostIP atomically writes the given IP to HostIPFile.
// Atomic write avoids leaving a half-written file if Spine crashes mid-write.
func WriteStoredHostIP(ip string) error {
	dir := filepath.Dir(HostIPFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".host_ip.tmp.*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(ip + "\n"); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(0644); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, HostIPFile)
}
