package developmentaccess

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const (
	PolicySchema       = "youeye.development-access.v1"
	StatusSchema       = "youeye.development-access-status.v2"
	legacyStatusSchema = "youeye.development-access-status.v1"
	DefaultRoot        = "/var/lib/youeye-state/bootstrap"

	notAppliedDetail = "Development access policy has not been applied on this boot"
)

type Policy struct {
	Schema           string `json:"schema"`
	LocalRootConsole bool   `json:"local_root_console"`
	RootPasswordSSH  bool   `json:"root_password_ssh"`
	PasswordHash     string `json:"password_hash,omitempty"`
	SSHNetworkScope  string `json:"ssh_network_scope,omitempty"`
}

type AppliedStatus struct {
	Schema                    string  `json:"schema"`
	LocalRootConsoleRequested bool    `json:"local_root_console_requested"`
	LocalRootConsolePersisted bool    `json:"local_root_console_persisted"`
	LocalRootConsoleActive    bool    `json:"local_root_console_active"`
	LocalRootConsoleEffective bool    `json:"local_root_console_effective"`
	RootPasswordSSHRequested  bool    `json:"root_password_ssh_requested"`
	RootPasswordSSHEffective  bool    `json:"root_password_ssh_effective"`
	NetworkScope              *string `json:"network_scope"`
	Detail                    string  `json:"detail"`
}

type requiredAppliedStatus struct {
	Schema                    *string `json:"schema"`
	LocalRootConsoleRequested *bool   `json:"local_root_console_requested"`
	LocalRootConsolePersisted *bool   `json:"local_root_console_persisted"`
	LocalRootConsoleActive    *bool   `json:"local_root_console_active"`
	LocalRootConsoleEffective *bool   `json:"local_root_console_effective"`
	RootPasswordSSHRequested  *bool   `json:"root_password_ssh_requested"`
	RootPasswordSSHEffective  *bool   `json:"root_password_ssh_effective"`
	NetworkScope              *string `json:"network_scope"`
	Detail                    *string `json:"detail"`
}

type Status struct {
	Schema                    string  `json:"schema"`
	LocalRootConsoleRequested bool    `json:"local_root_console_requested"`
	LocalRootConsolePersisted bool    `json:"local_root_console_persisted"`
	LocalRootConsoleActive    bool    `json:"local_root_console_active"`
	LocalRootConsoleEffective bool    `json:"local_root_console_effective"`
	RootPasswordSSHRequested  bool    `json:"root_password_ssh_requested"`
	RootPasswordSSHEffective  bool    `json:"root_password_ssh_effective"`
	NetworkScope              *string `json:"network_scope,omitempty"`
	Detail                    string  `json:"detail"`
	CanEnableRemotely         bool    `json:"can_enable_remotely"`
	CanDisableRemotely        bool    `json:"can_disable_remotely"`
}

type legacyAppliedStatus struct {
	Schema                   string  `json:"schema,omitempty"`
	LocalRootConsole         bool    `json:"local_root_console"`
	RootPasswordSSHRequested bool    `json:"root_password_ssh_requested"`
	RootPasswordSSHEffective bool    `json:"root_password_ssh_effective"`
	NetworkScope             *string `json:"network_scope"`
	Detail                   string  `json:"detail"`
}

type CommandRunner interface {
	Run(name string, args ...string) error
}

type execRunner struct{}

func (execRunner) Run(name string, args ...string) error {
	command := exec.Command(name, args...)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	return command.Run()
}

type Manager struct {
	Root   string
	Runner CommandRunner
	Now    func() time.Time
}

func NewDefault() *Manager {
	return &Manager{Root: DefaultRoot, Runner: execRunner{}, Now: time.Now}
}

func (manager *Manager) policyPath() string {
	return filepath.Join(manager.Root, "development-access.json")
}
func (manager *Manager) statusPath() string {
	return filepath.Join(manager.Root, "development-access-status.json")
}

func (manager *Manager) Status() (Status, error) {
	policy, err := readPolicy(manager.policyPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Status{Schema: StatusSchema, Detail: "Secure defaults active", CanDisableRemotely: true}, nil
		}
		return Status{}, err
	}
	applied := AppliedStatus{
		Schema:                    StatusSchema,
		LocalRootConsoleRequested: policy.LocalRootConsole,
		RootPasswordSSHRequested:  policy.RootPasswordSSH,
		Detail:                    notAppliedDetail,
	}
	if raw, readErr := os.ReadFile(manager.statusPath()); readErr == nil {
		var header struct {
			Schema string `json:"schema"`
		}
		if err := json.Unmarshal(raw, &header); err != nil {
			return Status{}, fmt.Errorf("read applied development access status: invalid status record")
		}
		switch header.Schema {
		case StatusSchema:
			var required requiredAppliedStatus
			if err := strictJSON(raw, &required); err != nil || required.Schema == nil ||
				required.LocalRootConsoleRequested == nil || required.LocalRootConsolePersisted == nil ||
				required.LocalRootConsoleActive == nil || required.LocalRootConsoleEffective == nil ||
				required.RootPasswordSSHRequested == nil || required.RootPasswordSSHEffective == nil ||
				required.Detail == nil || *required.Schema != StatusSchema {
				return Status{}, fmt.Errorf("read applied development access status: invalid status record")
			}
			applied = AppliedStatus{
				Schema:                    *required.Schema,
				LocalRootConsoleRequested: *required.LocalRootConsoleRequested,
				LocalRootConsolePersisted: *required.LocalRootConsolePersisted,
				LocalRootConsoleActive:    *required.LocalRootConsoleActive,
				LocalRootConsoleEffective: *required.LocalRootConsoleEffective,
				RootPasswordSSHRequested:  *required.RootPasswordSSHRequested,
				RootPasswordSSHEffective:  *required.RootPasswordSSHEffective,
				NetworkScope:              required.NetworkScope,
				Detail:                    *required.Detail,
			}
			if validateAppliedStatus(applied) != nil ||
				applied.LocalRootConsoleRequested != policy.LocalRootConsole ||
				applied.RootPasswordSSHRequested != policy.RootPasswordSSH {
				return Status{}, fmt.Errorf("read applied development access status: invalid status record")
			}
		case legacyStatusSchema:
			if err := strictJSON(raw, &legacyAppliedStatus{}); err != nil || !hasJSONFields(raw,
				"schema", "local_root_console", "root_password_ssh_requested",
				"root_password_ssh_effective", "network_scope", "detail",
			) {
				return Status{}, fmt.Errorf("read applied development access status: invalid status record")
			}
			// During the reader-first rollout, a legacy record only conveys that
			// policy was requested; none of its realized state is safe to report
			// before v2 has been applied.
		default:
			return Status{}, fmt.Errorf("read applied development access status: invalid status record")
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return Status{}, fmt.Errorf("read applied development access status: %w", readErr)
	}
	return Status{
		Schema:                    StatusSchema,
		LocalRootConsoleRequested: applied.LocalRootConsoleRequested,
		LocalRootConsolePersisted: applied.LocalRootConsolePersisted,
		LocalRootConsoleActive:    applied.LocalRootConsoleActive,
		LocalRootConsoleEffective: applied.LocalRootConsoleEffective,
		RootPasswordSSHRequested:  applied.RootPasswordSSHRequested,
		RootPasswordSSHEffective:  applied.RootPasswordSSHEffective,
		NetworkScope:              applied.NetworkScope,
		Detail:                    boundedStatusDetail(applied.Detail),
		CanEnableRemotely:         false,
		CanDisableRemotely:        true,
	}, nil
}

func validateAppliedStatus(applied AppliedStatus) error {
	if applied.LocalRootConsoleEffective && (!applied.LocalRootConsoleRequested || !applied.LocalRootConsolePersisted || !applied.LocalRootConsoleActive) {
		return errors.New("effective local root console must be requested, persisted, and active")
	}
	if applied.RootPasswordSSHEffective && (!applied.RootPasswordSSHRequested || applied.NetworkScope == nil || strings.TrimSpace(*applied.NetworkScope) == "") {
		return errors.New("effective root password SSH must be requested and scoped")
	}
	if !applied.RootPasswordSSHEffective && applied.NetworkScope != nil {
		return errors.New("inactive root password SSH must not report a network scope")
	}
	return nil
}

func boundedStatusDetail(detail string) string {
	detail = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) {
			return -1
		}
		return character
	}, strings.TrimSpace(detail))
	if detail == "" {
		return notAppliedDetail
	}
	runes := []rune(detail)
	if len(runes) > 160 {
		detail = string(runes[:160])
	}
	return detail
}

func (manager *Manager) Disable() (Status, error) {
	policy := Policy{Schema: PolicySchema}
	raw, err := json.Marshal(policy)
	if err != nil {
		return Status{}, err
	}
	if err := writeAtomic(manager.policyPath(), append(raw, '\n'), 0o600); err != nil {
		return Status{}, fmt.Errorf("disable development access: %w", err)
	}
	runner := manager.Runner
	if runner == nil {
		runner = execRunner{}
	}
	if err := runner.Run("/usr/local/libexec/youeye-apply-development-access"); err != nil {
		return Status{}, fmt.Errorf("apply disabled development access policy: %w", err)
	}
	return manager.Status()
}

func readPolicy(path string) (Policy, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Policy{}, err
	}
	var policy Policy
	if err := strictJSON(raw, &policy); err != nil {
		return Policy{}, fmt.Errorf("read development access policy: %w", err)
	}
	if policy.Schema != PolicySchema {
		return Policy{}, fmt.Errorf("unsupported development access policy schema %q", policy.Schema)
	}
	if policy.LocalRootConsole || policy.RootPasswordSSH {
		if !strings.HasPrefix(policy.PasswordHash, "$y$") {
			return Policy{}, errors.New("development access password hash is invalid")
		}
	} else if policy.PasswordHash != "" || policy.SSHNetworkScope != "" {
		return Policy{}, errors.New("disabled development access policy contains secret state")
	}
	if policy.RootPasswordSSH && policy.SSHNetworkScope != "local-subnet" {
		return Policy{}, errors.New("root password SSH is not limited to the local subnet")
	}
	return policy, nil
}

func strictJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

func hasJSONFields(raw []byte, names ...string) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return false
	}
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			return false
		}
	}
	return true
}

func writeAtomic(path string, raw []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".development-access-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}
