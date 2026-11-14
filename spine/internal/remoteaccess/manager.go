// Package remoteaccess manages the root SSH keys for a sealed appliance.
package remoteaccess

import (
	"bufio"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"

	"github.com/youeye-platform/YouEye/spine/internal/jsonkeep"
)

const (
	Schema              = "youeye.appliance.ssh-keys.v1"
	DefaultStorePath    = "/var/lib/youeye-state/remote-access/authorized-keys.json"
	DefaultAuditPath    = "/var/lib/youeye-state/remote-access/audit.jsonl"
	DefaultLivePath     = "/root/.ssh/authorized_keys"
	maximumKeys         = 128
	maximumKeyLineBytes = 16 * 1024
)

type Key struct {
	ID          string `json:"id" jsonkeep:"key"`
	Fingerprint string `json:"fingerprint"`
	Type        string `json:"type"`
	Bits        int    `json:"bits,omitempty"`
	Comment     string `json:"comment,omitempty"`
	PublicKey   string `json:"public_key"`
	Source      string `json:"source"`
	AddedAt     string `json:"added_at"`
}

type KeyMetadata struct {
	ID          string `json:"id" jsonkeep:"key"`
	Fingerprint string `json:"fingerprint"`
	Type        string `json:"type"`
	Bits        int    `json:"bits,omitempty"`
	Comment     string `json:"comment,omitempty"`
	Source      string `json:"source"`
	AddedAt     string `json:"added_at"`
}

func (k Key) Metadata() KeyMetadata {
	return KeyMetadata{
		ID: k.ID, Fingerprint: k.Fingerprint, Type: k.Type, Bits: k.Bits,
		Comment: k.Comment, Source: k.Source, AddedAt: k.AddedAt,
	}
}

func Metadata(keys []Key) []KeyMetadata {
	result := make([]KeyMetadata, 0, len(keys))
	for _, key := range keys {
		result = append(result, key.Metadata())
	}
	return result
}

type Store struct {
	Schema string `json:"schema"`
	Keys   []Key  `json:"keys"`
	// skipped holds keys this Spine can't use (a key type a newer Spine
	// accepts, say): not installed, but kept in the file.
	skipped []json.RawMessage
}

type Manager struct {
	StorePath string
	AuditPath string
	LivePath  string
	Now       func() time.Time
}

func NewDefault() *Manager {
	return &Manager{
		StorePath: DefaultStorePath,
		AuditPath: DefaultAuditPath,
		LivePath:  DefaultLivePath,
		Now:       time.Now,
	}
}

func ParsePublicKey(line string) (Key, error) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return Key{}, errors.New("SSH public key is empty")
	}
	if len(trimmed) > maximumKeyLineBytes {
		return Key{}, errors.New("SSH public key is too large")
	}
	if strings.Contains(trimmed, "PRIVATE KEY") {
		return Key{}, errors.New("private keys are not accepted")
	}
	publicKey, comment, options, rest, err := ssh.ParseAuthorizedKey([]byte(trimmed))
	if err != nil {
		return Key{}, fmt.Errorf("parse SSH public key: %w", err)
	}
	if len(options) != 0 {
		return Key{}, errors.New("authorized_keys options are not accepted")
	}
	if strings.TrimSpace(string(rest)) != "" {
		return Key{}, errors.New("exactly one SSH public key is required")
	}
	bits, err := validateAlgorithm(publicKey)
	if err != nil {
		return Key{}, err
	}
	comment = strings.TrimSpace(comment)
	if strings.ContainsAny(comment, "\r\n") {
		return Key{}, errors.New("SSH key comment must be one line")
	}
	normalized := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(publicKey)))
	if comment != "" {
		normalized += " " + comment
	}
	digest := sha256.Sum256(publicKey.Marshal())
	return Key{
		ID:          hex.EncodeToString(digest[:12]),
		Fingerprint: ssh.FingerprintSHA256(publicKey),
		Type:        publicKey.Type(),
		Bits:        bits,
		Comment:     comment,
		PublicKey:   normalized,
	}, nil
}

func validateAlgorithm(publicKey ssh.PublicKey) (int, error) {
	switch publicKey.Type() {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoSKED25519, ssh.KeyAlgoECDSA256,
		ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521, ssh.KeyAlgoSKECDSA256:
		return 0, nil
	case ssh.KeyAlgoRSA:
		cryptoKey, ok := publicKey.(ssh.CryptoPublicKey)
		if !ok {
			return 0, errors.New("could not inspect RSA public key")
		}
		rsaKey, ok := cryptoKey.CryptoPublicKey().(*rsa.PublicKey)
		if !ok {
			return 0, errors.New("could not inspect RSA public key")
		}
		bits := rsaKey.N.BitLen()
		if bits < 3072 {
			return 0, fmt.Errorf("RSA public keys must be at least 3072 bits; received %d", bits)
		}
		return bits, nil
	default:
		if strings.Contains(publicKey.Type(), "-cert-") {
			return 0, errors.New("SSH certificates are not accepted")
		}
		return 0, fmt.Errorf("unsupported SSH key type %q", publicKey.Type())
	}
}

func (m *Manager) List() ([]Key, error) {
	var keys []Key
	err := m.withLock(func() error {
		store, err := m.loadOrImport()
		if err != nil {
			return err
		}
		keys = append([]Key(nil), store.Keys...)
		// Keys this Spine can't use are listed as unsupported (not installed),
		// so they can still be seen and deleted.
		for _, raw := range store.skipped {
			if key, ok := skippedKey(raw); ok {
				keys = append(keys, key)
			}
		}
		return nil
	})
	return keys, err
}

// skippedKey is the listing of a kept key this Spine can't use.
func skippedKey(raw json.RawMessage) (Key, bool) {
	var key Key
	if json.Unmarshal(raw, &key) != nil || key.ID == "" {
		return Key{}, false
	}
	key.Type, key.PublicKey = "unsupported", ""
	return key, true
}

// dropSkipped removes kept unusable entries with id (a delete, or the same
// key added again in a form this Spine can use).
func (store *Store) dropSkipped(id string) bool {
	kept := store.skipped[:0]
	dropped := false
	for _, raw := range store.skipped {
		if key, ok := skippedKey(raw); ok && key.ID == id {
			dropped = true
			continue
		}
		kept = append(kept, raw)
	}
	store.skipped = kept
	return dropped
}

func (m *Manager) Add(line, source string) (Key, error) {
	key, err := ParsePublicKey(line)
	if err != nil {
		return Key{}, err
	}
	if strings.TrimSpace(source) == "" {
		source = "settings"
	}
	err = m.withLock(func() error {
		store, err := m.loadOrImport()
		if err != nil {
			return err
		}
		for _, existing := range store.Keys {
			if existing.ID == key.ID {
				key = existing
				return nil
			}
		}
		if len(store.Keys) >= maximumKeys {
			return fmt.Errorf("at most %d SSH keys may be managed", maximumKeys)
		}
		key.Source = source
		key.AddedAt = m.now().UTC().Format(time.RFC3339)
		store.dropSkipped(key.ID)
		store.Keys = append(store.Keys, key)
		sortKeys(store.Keys)
		if err := m.commit(store); err != nil {
			return err
		}
		return m.audit("add", key, len(store.Keys))
	})
	return key, err
}

func (m *Manager) Delete(id string, confirmLast bool) (Key, error) {
	var deleted Key
	err := m.withLock(func() error {
		store, err := m.loadOrImport()
		if err != nil {
			return err
		}
		index := -1
		for i, key := range store.Keys {
			if key.ID == id {
				index = i
				deleted = key
				break
			}
		}
		if index < 0 {
			if store.dropSkipped(id) {
				deleted = Key{ID: id, Type: "unsupported"}
				if err := m.commit(store); err != nil {
					return err
				}
				return m.audit("delete", deleted, len(store.Keys))
			}
			return os.ErrNotExist
		}
		if len(store.Keys) == 1 && !confirmLast {
			return errors.New("deleting the final SSH key requires explicit confirmation")
		}
		store.Keys = append(store.Keys[:index], store.Keys[index+1:]...)
		if err := m.commit(store); err != nil {
			return err
		}
		return m.audit("delete", deleted, len(store.Keys))
	})
	return deleted, err
}

func (m *Manager) Reconcile() error {
	return m.withLock(func() error {
		store, err := m.loadOrImport()
		if err != nil {
			return err
		}
		if err := m.writeLive(store.Keys); err != nil {
			return err
		}
		return m.audit("reconcile", Key{}, len(store.Keys))
	})
}

func (m *Manager) loadOrImport() (Store, error) {
	store, err := m.load()
	if err == nil {
		return store, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Store{}, err
	}
	store = Store{Schema: Schema, Keys: []Key{}}
	live, readErr := os.Open(m.LivePath)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return Store{}, fmt.Errorf("read existing authorized_keys: %w", readErr)
	}
	if readErr == nil {
		defer live.Close()
		scanner := bufio.NewScanner(live)
		scanner.Buffer(make([]byte, 4096), maximumKeyLineBytes)
		seen := map[string]bool{}
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, parseErr := ParsePublicKey(line)
			if parseErr != nil {
				return Store{}, fmt.Errorf("existing authorized_keys contains an unmanaged entry: %w", parseErr)
			}
			if seen[key.ID] {
				continue
			}
			key.Source = "installer"
			key.AddedAt = m.now().UTC().Format(time.RFC3339)
			store.Keys = append(store.Keys, key)
			seen[key.ID] = true
		}
		if err := scanner.Err(); err != nil {
			return Store{}, fmt.Errorf("scan existing authorized_keys: %w", err)
		}
	}
	sortKeys(store.Keys)
	if err := m.commit(store); err != nil {
		return Store{}, err
	}
	if err := m.audit("import", Key{}, len(store.Keys)); err != nil {
		return Store{}, err
	}
	return store, nil
}

func (m *Manager) load() (Store, error) {
	data, err := os.ReadFile(m.StorePath)
	if err != nil {
		return Store{}, err
	}
	// Read on every boot by the image's seed: unknown keys are ignored (and
	// kept by commit), and one key this Spine can't use is skipped and kept
	// instead of losing every managed key.
	var document struct {
		Schema string            `json:"schema"`
		Keys   []json.RawMessage `json:"keys"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(&document); err != nil {
		return Store{}, fmt.Errorf("decode managed SSH keys: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Store{}, err
	}
	if document.Schema != Schema {
		return Store{}, fmt.Errorf("unsupported managed SSH key schema %q", document.Schema)
	}
	store := Store{Schema: document.Schema}
	seen := make(map[string]bool, len(document.Keys))
	for _, raw := range document.Keys {
		var key Key
		if json.Unmarshal(raw, &key) != nil {
			store.skipped = append(store.skipped, raw)
			continue
		}
		parsed, err := ParsePublicKey(key.PublicKey)
		if err != nil || parsed.ID != key.ID || parsed.Fingerprint != key.Fingerprint || parsed.Type != key.Type || seen[parsed.ID] {
			store.skipped = append(store.skipped, raw)
			continue
		}
		seen[parsed.ID] = true
		store.Keys = append(store.Keys, key)
	}
	sortKeys(store.Keys)
	return store, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("managed SSH key file contains trailing JSON")
	}
	return nil
}

func (m *Manager) commit(store Store) error {
	store.Schema = Schema
	sortKeys(store.Keys)
	previous, _ := os.ReadFile(m.StorePath)
	data, err := jsonkeep.Marshal(store, previous)
	if err != nil {
		return err
	}
	if len(store.skipped) > 0 {
		var document map[string]json.RawMessage
		var keys []json.RawMessage
		if err := json.Unmarshal(data, &document); err != nil {
			return err
		}
		if err := json.Unmarshal(document["keys"], &keys); err != nil {
			return err
		}
		if document["keys"], err = json.Marshal(append(keys, store.skipped...)); err != nil {
			return err
		}
		if data, err = json.MarshalIndent(document, "", "  "); err != nil {
			return err
		}
		data = append(data, '\n')
	}
	if err := writeAtomic(m.StorePath, data, 0600); err != nil {
		return fmt.Errorf("write managed SSH keys: %w", err)
	}
	return m.writeLive(store.Keys)
}

func (m *Manager) writeLive(keys []Key) error {
	var content strings.Builder
	for _, key := range keys {
		content.WriteString(key.PublicKey)
		content.WriteByte('\n')
	}
	if err := writeAtomic(m.LivePath, []byte(content.String()), 0600); err != nil {
		return fmt.Errorf("write root authorized_keys: %w", err)
	}
	return nil
}

func (m *Manager) audit(action string, key Key, count int) error {
	event := struct {
		Schema      string `json:"schema"`
		Action      string `json:"action"`
		KeyID       string `json:"key_id,omitempty"`
		Fingerprint string `json:"fingerprint,omitempty"`
		Type        string `json:"type,omitempty"`
		KeyCount    int    `json:"key_count"`
		OccurredAt  string `json:"occurred_at"`
	}{Schema: "youeye.appliance.ssh-key-audit.v1", Action: action, KeyID: key.ID, Fingerprint: key.Fingerprint, Type: key.Type, KeyCount: count, OccurredAt: m.now().UTC().Format(time.RFC3339)}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.AuditPath), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(m.AuditPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("open SSH key audit journal: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("append SSH key audit journal: %w", err)
	}
	return file.Sync()
}

func (m *Manager) withLock(operation func() error) error {
	lockPath := m.StorePath + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX); err != nil {
		return err
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	return operation()
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".youeye-ssh-keys-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		tmp.Close()
		if !ok {
			os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return err
	}
	ok = true
	return nil
}

func sortKeys(keys []Key) {
	sort.Slice(keys, func(i, j int) bool { return keys[i].ID < keys[j].ID })
}

func (m *Manager) now() time.Time {
	if m.Now == nil {
		return time.Now()
	}
	return m.Now()
}
