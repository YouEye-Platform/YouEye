package container

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	controlProvisionJournalPath = "/var/lib/youeye/control/provision.json"
	controlDeploySecretPath     = "/var/lib/youeye/control/.deploy_secret"
)

type controlProvisionJournal struct {
	Schema    string    `json:"schema"`
	Container string    `json:"container"`
	Phase     string    `json:"phase"`
	UpdatedAt time.Time `json:"updated_at"`
}

type controlPanelObservation struct {
	Exists           bool
	AppBundle        bool
	ControlUnit      bool
	IdentityUnit     bool
	HostDeploySecret bool
}

func (o controlPanelObservation) ready() bool {
	return o.Exists && o.AppBundle && o.ControlUnit && o.IdentityUnit && o.HostDeploySecret
}

func (o controlPanelObservation) emptyPartial() bool {
	return o.Exists && !o.AppBundle && !o.ControlUnit && !o.IdentityUnit && !o.HostDeploySecret
}

func exactContainerExists(containerName string) (bool, error) {
	out, err := exec.Command("incus", "list", "--format", "csv", "-c", "n").Output()
	if err != nil {
		return false, fmt.Errorf("list Incus containers: %w", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == containerName {
			return true, nil
		}
	}
	return false, nil
}

func containerPathExists(containerName, path string) bool {
	return exec.Command("incus", "exec", containerName, "--", "test", "-e", path).Run() == nil
}

func inspectControlPanel(containerName, appDir string) controlPanelObservation {
	o := controlPanelObservation{
		Exists:           true,
		AppBundle:        containerPathExists(containerName, filepath.Join(appDir, "server.js")),
		ControlUnit:      containerPathExists(containerName, "/etc/systemd/system/youeye-control.service"),
		IdentityUnit:     containerPathExists(containerName, "/etc/systemd/system/youeye-id.service"),
		HostDeploySecret: fileExistsWithContent(controlDeploySecretPath),
	}
	return o
}

func fileExistsWithContent(path string) bool {
	data, err := os.ReadFile(path)
	return err == nil && strings.TrimSpace(string(data)) != ""
}

func readControlProvisionJournal(containerName string) (controlProvisionJournal, bool) {
	data, err := os.ReadFile(controlProvisionJournalPath)
	if err != nil {
		return controlProvisionJournal{}, false
	}
	var journal controlProvisionJournal
	if json.Unmarshal(data, &journal) != nil || journal.Schema != "youeye.control.provision.v1" || journal.Container != containerName {
		return controlProvisionJournal{}, false
	}
	return journal, true
}

func writeControlProvisionJournal(containerName, phase string) error {
	journal := controlProvisionJournal{
		Schema:    "youeye.control.provision.v1",
		Container: containerName,
		Phase:     phase,
		UpdatedAt: time.Now().UTC(),
	}
	data, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Control Panel provisioning journal: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(controlProvisionJournalPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create Control Panel state directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".provision-*.tmp")
	if err != nil {
		return fmt.Errorf("create Control Panel provisioning journal: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return fmt.Errorf("restrict Control Panel provisioning journal: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write Control Panel provisioning journal: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync Control Panel provisioning journal: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close Control Panel provisioning journal: %w", err)
	}
	if err := os.Rename(tmpPath, controlProvisionJournalPath); err != nil {
		return fmt.Errorf("publish Control Panel provisioning journal: %w", err)
	}
	dirHandle, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open Control Panel state directory: %w", err)
	}
	defer dirHandle.Close()
	if err := dirHandle.Sync(); err != nil {
		return fmt.Errorf("sync Control Panel state directory: %w", err)
	}
	return nil
}

func recoverDeploySecret(containerName string) error {
	cmd := exec.Command("incus", "exec", containerName, "--", "sh", "-c",
		"sed -n 's/^Environment=TEST_ADMIN_SECRET=//p' /etc/systemd/system/youeye-control.service | head -n 1")
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("inspect existing Control Panel deploy credential: %w", err)
	}
	secret := strings.TrimSpace(string(out))
	if len(secret) < 32 || strings.ContainsAny(secret, " \t\r\n") {
		return errors.New("existing Control Panel service has no recoverable deploy credential")
	}
	if err := os.MkdirAll(filepath.Dir(controlDeploySecretPath), 0700); err != nil {
		return fmt.Errorf("create Control Panel credential directory: %w", err)
	}
	if err := os.WriteFile(controlDeploySecretPath, []byte(secret), 0600); err != nil {
		return fmt.Errorf("restore Control Panel deploy credential: %w", err)
	}
	return nil
}

func canContinueControlProvisioning(observation controlPanelObservation, journalOwned bool) bool {
	if observation.ready() || observation.emptyPartial() || journalOwned {
		return true
	}
	return observation.AppBundle && observation.ControlUnit && observation.IdentityUnit && !observation.HostDeploySecret
}
