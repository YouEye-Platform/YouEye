// Package consoleaccess keeps the host's console accounts: one per YouEye ID
// admin (so a dead Control Panel never locks the owner out), plus an optional
// root password (advanced) and opt-in password SSH from the local subnet.
//
// The record lives on State (bootstrap/console-access.json). At every boot and
// after every change, Apply builds the host's passwd, shadow, group and gshadow
// from the image's own copies plus these accounts and bind-mounts them over
// /etc. Spine stores only yescrypt hashes; the Control Panel sends a password
// once, when an admin sets it.
package consoleaccess

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	yescrypt "github.com/openwall/yescrypt-go"

	"github.com/youeye-platform/YouEye/spine/internal/jsonkeep"
)

const (
	Schema = "youeye.console-access.v1"
	// AdminGroup holds every unlocked admin account; it has sudo.
	AdminGroup = "youeye-admins"
	AdminGID   = 2000
	firstUID   = 2001
)

// Account is one admin's host account. UserID is the YouEye ID user id; the
// host Username is chosen once and never follows a YouEye ID rename.
type Account struct {
	UserID       string `json:"user_id" jsonkeep:"key"`
	Username     string `json:"username"`
	UID          int    `json:"uid"`
	PasswordHash string `json:"password_hash,omitempty"`
	Admin        bool   `json:"admin"`
	Locked       bool   `json:"locked"`
}

// Record is bootstrap/console-access.json.
type Record struct {
	Schema           string `json:"schema"`
	RootPasswordHash string `json:"root_password_hash,omitempty"`
	PasswordSSH      bool   `json:"password_ssh"`
	// Claimed: an admin set was synced at least once (the box has an owner).
	// Factory reset clears it.
	Claimed  bool      `json:"claimed,omitempty"`
	Accounts []Account `json:"accounts"`
	// skipped holds accounts this Spine can't use (a newer Spine may write
	// another hash format or name rule): they are kept as written, never
	// rendered, and their names and uids stay reserved.
	skipped []json.RawMessage
}

var (
	hostName   = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	userIDPat  = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	yescryptRE = regexp.MustCompile(`^\$y\$[./A-Za-z0-9]+\$[./A-Za-z0-9]{1,86}\$[./A-Za-z0-9]{43}$`)
)

// Names that must never become an admin's host name even when the image
// doesn't define them (yet).
var reservedNames = map[string]bool{"root": true, AdminGroup: true, "admin": true, "sudo": true, "wheel": true,
	"shadow": true, "youeye": true, "incus": true, "incus-admin": true, "nobody": true, "daemon": true}

// ValidHash accepts the yescrypt hashes this package writes.
func ValidHash(hash string) bool { return yescryptRE.MatchString(hash) }

// HashPassword returns a yescrypt hash of password.
func HashPassword(password string) (string, error) {
	if err := validPassword(password); err != nil {
		return "", err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash, err := yescrypt.Hash([]byte(password), []byte("$y$j9T$"+cryptBase64(salt)))
	if err != nil {
		return "", err
	}
	if !ValidHash(string(hash)) {
		return "", errors.New("yescrypt produced an unexpected hash")
	}
	return string(hash), nil
}

func validPassword(password string) error {
	if len(password) < 8 || len(password) > 1024 || !utf8.ValidString(password) || strings.ContainsAny(password, "\x00\r\n") {
		return errors.New("console password must be 8 to 1024 characters on one line")
	}
	return nil
}

const cryptAlphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

func cryptBase64(source []byte) string {
	out := make([]byte, 0, (len(source)*8+5)/6)
	for i := 0; i < len(source); {
		value, bits := uint32(0), 0
		for ; bits < 24 && i < len(source); bits += 8 {
			value |= uint32(source[i]) << bits
			i++
		}
		for ; bits > 0; bits -= 6 {
			out = append(out, cryptAlphabet[value&0x3f])
			value >>= 6
		}
	}
	return string(out)
}

// Load reads the record; a missing file is an empty record. Unknown keys are
// ignored (and kept by Save). One account this Spine can't use is skipped and
// kept, so it never locks the other admins out.
func Load(path string) (Record, error) {
	record := Record{Schema: Schema}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return record, nil
	}
	if err != nil {
		return record, err
	}
	var document struct {
		Schema           string            `json:"schema"`
		RootPasswordHash string            `json:"root_password_hash"`
		PasswordSSH      bool              `json:"password_ssh"`
		Claimed          bool              `json:"claimed"`
		Accounts         []json.RawMessage `json:"accounts"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return Record{Schema: Schema}, fmt.Errorf("console access record is unreadable: %w", err)
	}
	if document.Schema != Schema {
		return Record{Schema: Schema}, fmt.Errorf("unsupported console access record %q", document.Schema)
	}
	record.RootPasswordHash, record.PasswordSSH, record.Claimed = document.RootPasswordHash, document.PasswordSSH, document.Claimed
	for _, rawAccount := range document.Accounts {
		var a Account
		if json.Unmarshal(rawAccount, &a) != nil || record.accountValid(a) != nil {
			record.skipped = append(record.skipped, rawAccount)
			continue
		}
		record.Accounts = append(record.Accounts, a)
	}
	return record, nil
}

// reserved lists the names and uids of skipped accounts.
func (r Record) reserved() (map[string]bool, map[int]bool) {
	names, uids := map[string]bool{}, map[int]bool{}
	for _, raw := range r.skipped {
		var a struct {
			Username string `json:"username"`
			UID      int    `json:"uid"`
		}
		if json.Unmarshal(raw, &a) == nil {
			names[a.Username], uids[a.UID] = true, true
		}
	}
	return names, uids
}

// skippedID returns the user_id of a skipped account ("" when unreadable).
func skippedID(raw json.RawMessage) string {
	var a struct {
		UserID string `json:"user_id"`
	}
	_ = json.Unmarshal(raw, &a)
	return a.UserID
}

func (r Record) accountValid(a Account) error {
	if !userIDPat.MatchString(a.UserID) || !hostName.MatchString(a.Username) || reservedNames[a.Username] || a.UID < firstUID || a.UID > 59999 {
		return fmt.Errorf("console account %q is invalid", a.Username)
	}
	if a.PasswordHash != "" && !ValidHash(a.PasswordHash) {
		return fmt.Errorf("console account %q has an invalid password hash", a.Username)
	}
	for _, other := range r.Accounts {
		if other.Username == a.Username || other.UID == a.UID || other.UserID == a.UserID {
			return fmt.Errorf("console account %q is duplicated", a.Username)
		}
	}
	return nil
}

// Validate checks the accounts this Spine writes. A root password hash it
// can't use is kept but treated as no root password (root stays locked).
func (r Record) Validate() error {
	names, uids := r.reserved()
	seen := Record{}
	for _, a := range r.Accounts {
		if err := seen.accountValid(a); err != nil {
			return err
		}
		if names[a.Username] || uids[a.UID] {
			return fmt.Errorf("console account %q is duplicated", a.Username)
		}
		seen.Accounts = append(seen.Accounts, a)
	}
	return nil
}

// Save writes the record (0600), keeping keys a newer Spine added.
func Save(path string, r Record) error {
	r.Schema = Schema
	sort.Slice(r.Accounts, func(i, j int) bool { return r.Accounts[i].UID < r.Accounts[j].UID })
	if err := r.Validate(); err != nil {
		return err
	}
	previous, _ := os.ReadFile(path)
	raw, err := jsonkeep.Marshal(r, previous)
	if err != nil {
		return err
	}
	if len(r.skipped) > 0 {
		var document map[string]json.RawMessage
		var accounts []json.RawMessage
		if err := json.Unmarshal(raw, &document); err != nil {
			return err
		}
		if err := json.Unmarshal(document["accounts"], &accounts); err != nil {
			return err
		}
		if document["accounts"], err = json.Marshal(append(accounts, r.skipped...)); err != nil {
			return err
		}
		if raw, err = json.MarshalIndent(document, "", "  "); err != nil {
			return err
		}
		raw = append(raw, '\n')
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".console-access-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
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
	return os.Rename(tmp.Name(), path)
}

func (r *Record) account(userID string) *Account {
	for i := range r.Accounts {
		if r.Accounts[i].UserID == userID {
			return &r.Accounts[i]
		}
	}
	return nil
}

// Admin is one current YouEye ID admin, as the Control Panel reports it.
type Admin struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
}

// Sync makes the admin accounts match admins exactly: a new admin gets an
// account (locked until it has a password), an admin missing from the list is
// locked at once. Accounts are never removed, so a uid is never reused.
// taken lists host names the image already uses.
func (r *Record) Sync(admins []Admin, taken map[string]bool) error {
	current := map[string]bool{}
	skipped := map[string]bool{}
	for _, raw := range r.skipped {
		skipped[skippedID(raw)] = true
	}
	for _, admin := range admins {
		if !userIDPat.MatchString(admin.UserID) || current[admin.UserID] {
			return fmt.Errorf("invalid or duplicate admin %q", admin.UserID)
		}
		current[admin.UserID] = true
		if a := r.account(admin.UserID); a != nil {
			a.Admin, a.Locked = true, a.PasswordHash == ""
			continue
		}
		// An account this Spine can't read is still that admin's: never make a
		// second one (it would shadow the first under another name).
		if skipped[admin.UserID] {
			continue
		}
		r.Accounts = append(r.Accounts, Account{UserID: admin.UserID, Username: r.hostUsername(admin.Username, taken),
			UID: r.nextUID(), Admin: true, Locked: true})
	}
	if len(admins) > 0 {
		r.Claimed = true
	}
	// Demotion locks at once and forgets the console password: a promoted-again
	// admin must set a new one (the old one may have leaked meanwhile).
	for i := range r.Accounts {
		if !current[r.Accounts[i].UserID] {
			r.Accounts[i].Admin, r.Accounts[i].Locked, r.Accounts[i].PasswordHash = false, true, ""
		}
	}
	for i, raw := range r.skipped {
		if id := skippedID(raw); id != "" && !current[id] {
			var object map[string]json.RawMessage
			if json.Unmarshal(raw, &object) == nil {
				object["admin"], object["locked"] = json.RawMessage("false"), json.RawMessage("true")
				delete(object, "password_hash")
				if out, err := json.Marshal(object); err == nil {
					r.skipped[i] = out
				}
			}
		}
	}
	return nil
}

// ClearPassword forgets an account's console password and locks it (the
// Control Panel calls this when a new password could not be delivered, so an
// old one never keeps working).
func (r *Record) ClearPassword(userID string) {
	if a := r.account(userID); a != nil {
		a.PasswordHash, a.Locked = "", true
	}
}

// SetPassword stores the hash of an admin's console password and unlocks the
// account. Only a current admin has one.
func (r *Record) SetPassword(userID, password string) error {
	a := r.account(userID)
	if a == nil || !a.Admin {
		return errors.New("only an admin has a console account")
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	a.PasswordHash, a.Locked = hash, false
	return nil
}

func (r *Record) nextUID() int {
	uid := firstUID
	_, reserved := r.reserved()
	for used := range reserved {
		if used >= uid {
			uid = used + 1
		}
	}
	for _, a := range r.Accounts {
		if a.UID >= uid {
			uid = a.UID + 1
		}
	}
	return uid
}

// hostUsername maps a YouEye ID username to a free, valid host name: the name
// itself when it is a valid Linux name that the image and other accounts don't
// use, else ye-<name> (sanitised), with -2, -3… on a clash.
func (r *Record) hostUsername(name string, taken map[string]bool) string {
	skipped, _ := r.reserved()
	used := func(candidate string) bool {
		if taken[candidate] || reservedNames[candidate] || skipped[candidate] {
			return true
		}
		for _, a := range r.Accounts {
			if a.Username == candidate {
				return true
			}
		}
		return false
	}
	lower := strings.ToLower(name)
	if hostName.MatchString(lower) && !strings.HasPrefix(lower, "ye-") && !used(lower) {
		return lower
	}
	clean := strings.Trim(regexp.MustCompile(`[^a-z0-9_-]+`).ReplaceAllString(lower, "-"), "-")
	if len(clean) > 24 {
		clean = clean[:24]
	}
	if clean == "" {
		clean = "admin"
	}
	base := "ye-" + clean
	candidate := base
	for n := 2; used(candidate); n++ {
		candidate = fmt.Sprintf("%s-%d", base, n)
	}
	return candidate
}
