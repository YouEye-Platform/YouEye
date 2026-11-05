package systemupdate

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type copyAuthorityFile struct {
	Container    string      `json:"container,omitempty"`
	Path         string      `json:"path"`
	SourceSHA256 string      `json:"source_sha256"`
	Content      string      `json:"content"`
	Mode         os.FileMode `json:"mode"`
}
type copyAuthorityJournal struct {
	Schema   string              `json:"schema"`
	Request  CoreCopyRequest     `json:"request"`
	Files    []copyAuthorityFile `json:"files"`
	Prepared bool                `json:"prepared"`
}

// PrepareIndependentCopyRuntimeAuthority replaces host/CP/UI/Pointer machine
// secrets while all inherited containers are stopped. This is an intermediate
// phase: Identity database authority, Incus trust, Names and app credentials
// still require their owning coordinators before any network release.
func (m CoreManager) PrepareIndependentCopyRuntimeAuthority(ctx context.Context, request CoreCopyRequest, b CoreLifecycleBarrier, p NativeCoreCheckpoint, observeHardware func() (string, error)) error {
	if request.Validate() != nil || observeHardware == nil || !filepath.IsAbs(p.DataRoot) {
		return fmt.Errorf("exact native runtime copy context required")
	}
	hardware, err := observeHardware()
	if err != nil || hardware != request.DestinationHardware {
		return fmt.Errorf("runtime copy reached different hardware")
	}
	unlock, err := m.lockCoreRaw()
	if err != nil {
		return err
	}
	defer unlock()
	admitted, err := m.readCopy()
	if err != nil || admitted.Request != request || admitted.Phase != "verifying" {
		return fmt.Errorf("native copy admission required")
	}
	reservation, err := b.ReadCopy()
	if err != nil || reservation.Role != "destination" || reservation.Request != request {
		return fmt.Errorf("destination lifecycle reservation required")
	}
	source, err := m.ReadCopySource(request)
	if err != nil || !source.Quiesced {
		return fmt.Errorf("quiesced source inventory required")
	}
	if err = verifyCopyStoppedRuntime(ctx, p, source); err != nil {
		return err
	}
	journalPath := filepath.Join(m.Root, "copy-runtime-authority.json")
	var j copyAuthorityJournal
	raw, err := ReadCoreState(journalPath, 2<<20)
	if err == nil {
		if json.Unmarshal(raw, &j) != nil || j.Schema != "youeye.copy-runtime-authority.v1" || j.Request.Validate() != nil {
			return fmt.Errorf("invalid runtime authority journal")
		}
		if j.Request != request {
			var previous CoreCopyJournal
			prior, e := ReadCoreState(filepath.Join(m.Root, "copy-history", j.Request.RequestID+".json"), 4<<20)
			if e != nil || json.Unmarshal(prior, &previous) != nil || previous.Request != j.Request || previous.Phase != "committed" || j.Request.DestinationHardware != request.SourceHardware || !j.Prepared {
				return fmt.Errorf("another copy owns runtime authority")
			}
			// Repeated copies replace old private preparation material; the public
			// committed copy receipt retains the earlier provenance.
			err = os.ErrNotExist
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		current, e := inspectCopyRuntimeAuthority(ctx, p)
		if e != nil || current != source.Resources.RuntimeAuthoritySHA256 {
			return fmt.Errorf("copied runtime authority differs from frozen source inventory")
		}
		files, e := prepareCopyAuthorityFiles(ctx, p)
		if e != nil {
			return e
		}
		j = copyAuthorityJournal{Schema: "youeye.copy-runtime-authority.v1", Request: request, Files: files}
		raw, e = json.Marshal(j)
		if e != nil {
			return e
		}
		if e = atomicWrite(journalPath, raw, 0600); e != nil {
			return e
		}
	} else if err != nil {
		return err
	}
	if err = validateCopyAuthorityFiles(j.Files, p.DataRoot); err != nil {
		return err
	}
	for _, file := range j.Files {
		current, e := readCopyAuthorityFile(ctx, p, file)
		if e != nil {
			return e
		}
		if string(current) == file.Content {
			continue
		}
		if copyAuthorityDigest(current) != file.SourceSHA256 {
			return fmt.Errorf("runtime authority changed outside copy preparation")
		}
		if file.Container == "" {
			e = atomicWrite(file.Path, []byte(file.Content), file.Mode)
		} else {
			stage := filepath.Join(m.Root, "copy-authority-stage")
			if e = atomicWrite(stage, []byte(file.Content), 0600); e != nil {
				return e
			}
			_, e = p.capture(ctx, "incus", "file", "push", "--uid=0", "--gid=0", fmt.Sprintf("--mode=%04o", file.Mode), stage, file.Container+file.Path)
			removeErr := os.Remove(stage)
			if e == nil {
				e = removeErr
			}
		}
		if e != nil {
			return fmt.Errorf("runtime authority write requires reconciliation")
		}
		after, e := readCopyAuthorityFile(ctx, p, file)
		if e != nil || string(after) != file.Content {
			return fmt.Errorf("runtime authority did not read back")
		}
	}
	if !j.Prepared {
		// These private CP replay journals can contain the source's current app
		// passwords and tokens after a copy-of-copy. Containers are stopped and
		// no destination platform phase has begun. Keep public native receipts,
		// but never carry prior private preparation material into the new guest.
		if err = removeInheritedCopyJournals(filepath.Join(p.DataRoot, "state", "independent-copies")); err != nil {
			return err
		}
	}
	j.Prepared = true
	raw, err = json.Marshal(j)
	if err != nil {
		return err
	}
	return atomicWrite(journalPath, raw, 0600)
}

func removeInheritedCopyJournals(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() {
		return fmt.Errorf("inherited private copy journal directory is unsafe")
	}
	if err = os.RemoveAll(directory); err != nil {
		return err
	}
	parent, err := os.Open(filepath.Dir(directory))
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func copyAuthorityDigest(raw []byte) string { return fmt.Sprintf("%x", sha256.Sum256(raw)) }

func inspectCopyRuntimeAuthority(ctx context.Context, p NativeCoreCheckpoint) (string, error) {
	files, err := prepareCopyAuthorityFiles(ctx, p)
	if err != nil {
		return "", err
	}
	// Hash the original bindings only. Generated replacement material is not
	// persisted or returned by this read-only source observation.
	for i := range files {
		files[i].Content = ""
	}
	raw, err := json.Marshal(files)
	if err != nil {
		return "", err
	}
	return copyAuthorityDigest(raw), nil
}

func verifyCopyStoppedRuntime(ctx context.Context, p NativeCoreCheckpoint, source CopySourceContext) error {
	raw, err := p.capture(ctx, "incus", "list", "--format=json")
	if err != nil {
		return fmt.Errorf("copy runtime observation unavailable")
	}
	var actual []struct {
		Name   string            `json:"name"`
		Status string            `json:"status"`
		Config map[string]string `json:"config"`
	}
	if json.Unmarshal(raw, &actual) != nil || len(actual) != len(source.Resources.Containers) {
		return fmt.Errorf("copy runtime set changed")
	}
	seen := map[string]bool{}
	for _, c := range actual {
		found := false
		for _, expected := range source.Resources.Containers {
			if c.Name == expected.Name && c.Config["volatile.uuid"] == expected.UUID {
				found = true
				break
			}
		}
		if !found || seen[c.Name] || c.Status != "Stopped" || c.Config["boot.autostart"] != "false" {
			return fmt.Errorf("copy runtime must remain stopped with automatic startup disabled")
		}
		seen[c.Name] = true
	}
	return nil
}

func readCopyAuthorityFile(ctx context.Context, p NativeCoreCheckpoint, file copyAuthorityFile) ([]byte, error) {
	if file.Container != "" {
		raw, err := p.capture(ctx, "incus", "file", "pull", file.Container+file.Path, "-")
		if err != nil || len(raw) > 1<<20 {
			return nil, fmt.Errorf("copied runtime configuration unavailable")
		}
		return raw, nil
	}
	raw, err := ReadCoreState(file.Path, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("protected copied runtime configuration unavailable")
	}
	return raw, nil
}

func copyAuthorityTargets(root string) []copyAuthorityFile {
	return []copyAuthorityFile{
		{Path: filepath.Join(root, "control/.deploy_secret"), Mode: 0600},
		{Path: filepath.Join(root, "control/.bridge_token"), Mode: 0600},
		{Path: filepath.Join(root, "config/cli-token"), Mode: 0600},
		{Path: filepath.Join(root, "pointer/.jwt_secret"), Mode: 0600},
		{Path: filepath.Join(root, "pointer/.encryption_secret"), Mode: 0600},
		{Path: filepath.Join(root, "ui/.env"), Mode: 0600},
		{Container: "youeye-control", Path: "/etc/systemd/system/youeye-control.service", Mode: 0644},
		{Container: "youeye-control", Path: "/etc/systemd/system/youeye-id.service", Mode: 0644},
		{Container: "youeye-control", Path: "/etc/youeye/ui-bridge-token", Mode: 0600},
		{Container: "youeye-control", Path: "/etc/youeye/cli-token", Mode: 0600},
		{Container: "youeye-ui", Path: "/etc/youeye/ui-bridge-token", Mode: 0600},
		{Container: "youeye-ui", Path: "/etc/youeye-ui.env", Mode: 0600},
		{Path: filepath.Join(root, "pihole/.web_password"), Mode: 0600},
		{Path: filepath.Join(root, "postgres/.pg_password"), Mode: 0600},
		{Container: "youeye-pointer", Path: "/etc/youeye-pointer.env", Mode: 0600},
	}
}
func validateCopyAuthorityFiles(files []copyAuthorityFile, root string) error {
	expected := copyAuthorityTargets(root)
	if len(files) != len(expected) {
		return fmt.Errorf("runtime authority inventory changed")
	}
	for i, f := range files {
		want := expected[i]
		if f.Path != want.Path || f.Container != want.Container || f.Mode != want.Mode || !validSHA256(f.SourceSHA256) || f.Content == "" || len(f.Content) > 1<<20 {
			return fmt.Errorf("invalid copied runtime authority target")
		}
	}
	return nil
}
func prepareCopyAuthorityFiles(ctx context.Context, p NativeCoreCheckpoint) ([]copyAuthorityFile, error) {
	secrets := map[string]string{}
	for _, name := range []string{"deploy", "bridge", "cli", "pointer-jwt", "pointer-encryption", "ui-jwt", "cp-jwt", "identity-jwt", "pihole", "postgres"} {
		var data [32]byte
		if _, err := rand.Read(data[:]); err != nil {
			return nil, err
		}
		secrets[name] = hex.EncodeToString(data[:])
	}
	files := copyAuthorityTargets(p.DataRoot)
	for i := range files {
		file := &files[i]
		raw, err := readCopyAuthorityFile(ctx, p, *file)
		if err != nil {
			return nil, err
		}
		file.SourceSHA256 = copyAuthorityDigest(raw)
		var value string
		switch i {
		case 0:
			value = secrets["deploy"]
		case 1, 8, 10:
			value = secrets["bridge"]
		case 2, 9:
			value = secrets["cli"]
		case 3:
			value = secrets["pointer-jwt"]
		case 4:
			value = secrets["pointer-encryption"]
		case 5, 11:
			value, err = replaceCopyEnvironment(string(raw), "", map[string]string{"JWT_SECRET": secrets["ui-jwt"]})
			if err == nil {
				value, err = replaceCopyDatabaseURL(value, secrets["postgres"], "youeye_ui")
			}
		case 6:
			value, err = replaceCopyEnvironment(string(raw), "Environment=", map[string]string{"JWT_SECRET": secrets["cp-jwt"], "TEST_ADMIN_SECRET": secrets["deploy"]})
			if err == nil && strings.Contains(value, "Environment=PIHOLE_PASSWORD=") {
				value, err = replaceCopyEnvironment(value, "Environment=", map[string]string{"PIHOLE_PASSWORD": secrets["pihole"]})
			}
		case 13:
			value = secrets["postgres"]
		case 14:
			value, err = replaceCopyEnvironment(string(raw), "", map[string]string{"JWT_SECRET": secrets["pointer-jwt"], "ENCRYPTION_SECRET": secrets["pointer-encryption"]})
			if err == nil {
				value, err = replaceCopyDatabaseURL(value, secrets["postgres"], "pointer")
			}
		case 12:
			value = secrets["pihole"]
		case 7:
			value, err = replaceCopyEnvironment(string(raw), "Environment=", map[string]string{"JWT_SECRET": secrets["identity-jwt"]})
		}
		if err != nil {
			return nil, err
		}
		file.Content = value
	}
	return files, nil
}

// Replace only exact declared credentials. Unsupported/missing/duplicate
// declarations reject instead of appending a guessed systemd override.
func replaceCopyEnvironment(raw, prefix string, values map[string]string) (string, error) {
	lines := strings.Split(raw, "\n")
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		needle := prefix + key + "="
		count := 0
		for i, line := range lines {
			if strings.HasPrefix(line, needle) {
				count++
				if strings.TrimPrefix(line, needle) == "" {
					return "", fmt.Errorf("copied credential is empty")
				}
				lines[i] = needle + values[key]
			}
		}
		if count != 1 {
			return "", fmt.Errorf("copied credential declaration is not exact")
		}
	}
	return strings.Join(lines, "\n"), nil
}

// Keep the exact local database/user/address. Only the machine password changes.
func replaceCopyDatabaseURL(raw, password, database string) (string, error) {
	var before string
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "DATABASE_URL=") {
			if before != "" {
				return "", fmt.Errorf("ambiguous copied database binding")
			}
			before = strings.TrimPrefix(line, "DATABASE_URL=")
		}
	}
	u, err := url.Parse(before)
	if err != nil || (u.Scheme != "postgresql" && u.Scheme != "postgres") || u.User == nil || u.User.Username() != "youeye" || u.Hostname() == "" || u.Path != "/"+database || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("unsupported copied platform database binding")
	}
	if old, ok := u.User.Password(); !ok || old == "" {
		return "", fmt.Errorf("copied platform database credential missing")
	}
	u.User = url.UserPassword("youeye", password)
	return replaceCopyEnvironment(raw, "", map[string]string{"DATABASE_URL": u.String()})
}
