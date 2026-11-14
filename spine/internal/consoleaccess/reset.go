package consoleaccess

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The Recovery menu's "Reset owner password" queues a request; at the next
// boot the System issues a one-time code, shows it on the console and keeps
// only its digest on State. The Control Panel's reset page accepts the code
// once to set a new owner password.

const resetSchema = "youeye.owner-reset.v1"

// codeAlphabet avoids look-alike characters (0/O, 1/I/L).
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

type resetRecord struct {
	Schema    string `json:"schema"`
	SHA256    string `json:"code_sha256"`
	ExpiresAt string `json:"expires_at"`
	Attempts  int    `json:"attempts"`
	// After every 10 wrong tries the code pauses for 15 minutes (it is never
	// voided by wrong tries, so nobody can stop the owner's reset that way).
	PausedUntil string `json:"paused_until,omitempty"`
}

// CodePath is where the console screen reads the code to show (tmpfs, root only).
func (m *Manager) CodePath() string { return filepath.Join(m.RunDir, "owner-reset-code") }

// IssueResetCode creates a new one-time code valid for 24 hours. Only the
// console screen shows it (from CodePath); never print or log it.
func (m *Manager) IssueResetCode() (string, error) {
	unlock, err := m.lock()
	if err != nil {
		return "", err
	}
	defer unlock()
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	var code strings.Builder
	for i, b := range raw {
		if i == 5 {
			code.WriteByte('-')
		}
		code.WriteByte(codeAlphabet[int(b)%len(codeAlphabet)])
	}
	sum := sha256.Sum256([]byte(normalizeCode(code.String())))
	record := resetRecord{Schema: resetSchema, SHA256: hex.EncodeToString(sum[:]), ExpiresAt: m.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)}
	if err := writePrivateJSON(m.ResetPath, record); err != nil {
		return "", err
	}
	if err := os.MkdirAll(m.RunDir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(m.CodePath(), []byte(code.String()+"\n"), 0o600); err != nil {
		return "", err
	}
	return code.String(), nil
}

// ErrResetCode means the code is wrong, used, expired or was tried too often.
var ErrResetCode = errors.New("the reset code is not valid")

// UseResetCode consumes a matching code. After every 10 wrong tries it pauses
// for 15 minutes; with ~49 bits per code guessing stays hopeless.
func (m *Manager) UseResetCode(code string) error {
	unlock, err := m.lock()
	if err != nil {
		return err
	}
	defer unlock()
	raw, err := os.ReadFile(m.ResetPath)
	if err != nil {
		return ErrResetCode
	}
	var record resetRecord
	if json.Unmarshal(raw, &record) != nil || record.Schema != resetSchema {
		m.clearReset()
		return ErrResetCode
	}
	expires, err := time.Parse(time.RFC3339, record.ExpiresAt)
	if err != nil || m.Now().After(expires) {
		m.clearReset()
		return ErrResetCode
	}
	if paused, err := time.Parse(time.RFC3339, record.PausedUntil); err == nil && m.Now().Before(paused) {
		return ErrResetCode
	}
	sum := sha256.Sum256([]byte(normalizeCode(code)))
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(record.SHA256)) != 1 {
		record.Attempts++
		if record.Attempts%10 == 0 {
			record.PausedUntil = m.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339)
		}
		_ = writePrivateJSON(m.ResetPath, record)
		return ErrResetCode
	}
	m.clearReset()
	return nil
}

func (m *Manager) clearReset() {
	_ = os.Remove(m.ResetPath)
	_ = os.Remove(m.CodePath())
}

func normalizeCode(code string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || r == ' ' {
			return -1
		}
		return r
	}, strings.ToUpper(strings.TrimSpace(code)))
}

func writePrivateJSON(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Status is what the Control Panel shows: never a hash.
type Status struct {
	Accounts []AccountStatus `json:"accounts"`
	// RootPasswordSet: the advanced root password exists (root can log in on
	// the console, and by password SSH when that is on).
	RootPasswordSet bool   `json:"root_password_set"`
	PasswordSSH     bool   `json:"password_ssh"`
	SSHScope        string `json:"ssh_scope,omitempty"`
	// Claimed: the box has had an admin (set by the first admin sync; only a
	// factory reset clears it).
	Claimed      bool `json:"claimed"`
	ResetPending bool `json:"owner_reset_pending"`
}

type AccountStatus struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	Admin       bool   `json:"admin"`
	Locked      bool   `json:"locked"`
	HasPassword bool   `json:"has_password"`
	// Unsupported: written by a newer Spine in a form this one can't use; it
	// can't sign in until that Spine runs again.
	Unsupported bool `json:"unsupported,omitempty"`
}

func (m *Manager) Status() (Status, error) {
	record, err := Load(m.RecordPath)
	if err != nil {
		return Status{}, err
	}
	status := Status{Accounts: []AccountStatus{}, RootPasswordSet: ValidHash(record.RootPasswordHash), PasswordSSH: record.PasswordSSH, Claimed: record.Claimed}
	if record.PasswordSSH {
		status.SSHScope = m.Subnet()
	}
	for _, a := range record.Accounts {
		status.Accounts = append(status.Accounts, AccountStatus{UserID: a.UserID, Username: a.Username, Admin: a.Admin, Locked: a.Locked, HasPassword: a.PasswordHash != ""})
	}
	for _, raw := range record.skipped {
		var a struct {
			UserID   string `json:"user_id"`
			Username string `json:"username"`
			Admin    bool   `json:"admin"`
		}
		if json.Unmarshal(raw, &a) == nil {
			status.Accounts = append(status.Accounts, AccountStatus{UserID: a.UserID, Username: a.Username, Admin: a.Admin, Locked: true, Unsupported: true})
		}
	}
	_, err = os.Stat(m.ResetPath)
	status.ResetPending = err == nil
	return status, nil
}

// Change loads the record, applies change, saves it and applies it to the host.
func (m *Manager) Change(change func(*Record, map[string]bool) error) error {
	unlock, err := m.lock()
	if err != nil {
		return err
	}
	defer unlock()
	record, err := Load(m.RecordPath)
	if err != nil {
		return err
	}
	taken, err := m.Taken()
	if err != nil {
		return err
	}
	if err := change(&record, taken); err != nil {
		return err
	}
	if err := Save(m.RecordPath, record); err != nil {
		return err
	}
	return m.apply()
}
