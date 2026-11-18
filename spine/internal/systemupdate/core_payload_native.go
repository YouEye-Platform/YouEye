package systemupdate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

var coreContainerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

func nativeCoreIncusClient() (*http.Client, *http.Transport) {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", "/var/lib/incus/unix.socket")
	}}
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return client, transport
}

func nativeCoreContainerPID(ctx context.Context, container string) (int, error) {
	client, transport := nativeCoreIncusClient()
	defer transport.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, "GET", "http://incus/1.0/instances/"+container+"/state?project=default", nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("core container state unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("core container state unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return 0, fmt.Errorf("invalid core container state")
	}
	var state struct {
		Type     string `json:"type"`
		Metadata struct {
			PID    int    `json:"pid"`
			Status string `json:"status"`
		} `json:"metadata"`
	}
	if json.Unmarshal(raw, &state) != nil || state.Type != "sync" || state.Metadata.PID <= 1 || state.Metadata.Status != "Running" {
		return 0, fmt.Errorf("core container is not running")
	}
	return state.Metadata.PID, nil
}

// VerifyCoreContainerPayload hashes bytes through host-owned descriptors anchored
// to Incus's current init process. No executable from the container is trusted.
// A held update container must be started before observing its staged payload.
// The mode decides whether differences are refused; see CorePayloadMode.
func VerifyCoreContainerPayload(ctx context.Context, container, appDir string, index CorePayloadIndex, mode CorePayloadMode) (CorePayloadFindings, error) {
	return verifyCoreContainerPayload(ctx, container, appDir, index, mode, nativeCoreContainerPID)
}

func verifyCoreContainerPayload(ctx context.Context, container, appDir string, index CorePayloadIndex, mode CorePayloadMode, observe func(context.Context, string) (int, error)) (CorePayloadFindings, error) {
	var found CorePayloadFindings
	if err := index.Validate(); err != nil {
		return found, err
	}
	if !coreContainerName.MatchString(container) || !filepath.IsAbs(appDir) || filepath.Clean(appDir) != appDir || appDir == "/" || strings.ContainsAny(appDir, "\x00\r\n\\") {
		return found, fmt.Errorf("exact core container and application directory required")
	}
	pid, err := observe(ctx, container)
	if err != nil {
		return found, err
	}
	identity, err := nativeProcessIdentity(pid)
	if err != nil {
		return found, fmt.Errorf("core container process unavailable")
	}
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return found, fmt.Errorf("core container filesystem unavailable")
	}
	defer root.Close()
	// Each path component is opened without following links; ancestor replacement
	// cannot redirect subsequent reads outside the anchored filesystem.
	dir, err := openCorePayloadDirectory(int(root.Fd()), strings.TrimPrefix(appDir, "/"))
	if err != nil {
		return found, err
	}
	defer dir.Close()
	found, err = verifyCorePayloadDescriptor(ctx, dir, index, mode)
	if err != nil {
		return found, err
	}
	current, err := observe(ctx, container)
	if err != nil || current != pid {
		return found, fmt.Errorf("core container changed during observation")
	}
	after, err := nativeProcessIdentity(pid)
	if err != nil || after != identity {
		return found, fmt.Errorf("core container process changed during observation")
	}
	return found, nil
}

func openCorePayloadDirectory(root int, rel string) (*os.File, error) {
	fd, err := unix.Dup(root)
	if err != nil {
		return nil, err
	}
	unix.CloseOnExec(fd)
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			unix.Close(fd)
			return nil, fmt.Errorf("unsafe core directory")
		}
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return nil, fmt.Errorf("core directory is unavailable or linked")
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), rel), nil
}

func openCorePayloadDirectoryFromRoot(root string) (*os.File, error) {
	base, err := os.Open("/")
	if err != nil {
		return nil, err
	}
	defer base.Close()
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return openCorePayloadDirectory(int(base.Fd()), strings.TrimPrefix(absolute, "/"))
}

// verifyCorePayloadDescriptor walks the whole tree and reports everything it
// finds; it does not stop at the first difference. A problem with one recorded
// path (it cannot be read, or it changes while it is read) is a finding about
// that path, so a damaged tree that is about to be replaced can still be
// replaced. Only a cancelled context or an unlistable root is an error in record
// mode. Strict mode adds one refusal: a recorded path is missing or changed.
func verifyCorePayloadDescriptor(ctx context.Context, root *os.File, index CorePayloadIndex, mode CorePayloadMode) (CorePayloadFindings, error) {
	var found CorePayloadFindings
	expected := make(map[string]CorePayloadEntry, len(index.Entries))
	for _, e := range index.Entries {
		expected[e.Path] = e
	}
	// walkUnrecorded only counts. Such a directory belongs to nobody we know: it
	// may change or vanish while it is listed, and nothing in it can be an error.
	var walkUnrecorded func(*os.File, string, int) error
	walkUnrecorded = func(dir *os.File, prefix string, depth int) error {
		for {
			children, err := dir.ReadDir(128)
			for _, child := range children {
				if err := ctx.Err(); err != nil {
					return err
				}
				if found.Unrecorded >= corePayloadUnrecordedLimit {
					found.UnrecordedCapped = true
					return nil
				}
				rel := prefix + "/" + child.Name()
				found.note(rel, "unrecorded-path")
				if !child.IsDir() {
					continue
				}
				if depth >= corePayloadUnrecordedDepth {
					found.UnrecordedCapped = true
					continue
				}
				sub, err := openCorePayloadDirectory(int(dir.Fd()), child.Name())
				if err != nil {
					continue
				}
				err = walkUnrecorded(sub, rel, depth+1)
				sub.Close()
				if err != nil {
					return err
				}
			}
			if err != nil {
				return nil
			}
		}
	}
	var walk func(*os.File, string) error
	walk = func(dir *os.File, prefix string) error {
		for {
			children, err := dir.ReadDir(128)
			if err != nil && err != io.EOF {
				if prefix == "" {
					return fmt.Errorf("core directory observation failed")
				}
				// Its unlisted children are reported missing below.
				found.note(prefix, "unreadable")
				return nil
			}
			for _, child := range children {
				if err := ctx.Err(); err != nil {
					return err
				}
				name := child.Name()
				rel := name
				if prefix != "" {
					rel = prefix + "/" + name
				}
				if mutableCorePayloadPath(rel) {
					continue
				}
				e, ok := expected[rel]
				if !ok {
					if found.Unrecorded >= corePayloadUnrecordedLimit {
						found.UnrecordedCapped = true
						continue
					}
					found.note(rel, "unrecorded-path")
					if child.IsDir() {
						if sub, err := openCorePayloadDirectory(int(dir.Fd()), name); err == nil {
							err = walkUnrecorded(sub, rel, 1)
							sub.Close()
							if err != nil {
								return err
							}
						}
					}
					continue
				}
				var stat unix.Stat_t
				if err := unix.Fstatat(int(dir.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
					if err == unix.ENOENT {
						continue // removed while listing: reported missing below
					}
					delete(expected, rel)
					found.note(rel, "unreadable")
					continue
				}
				delete(expected, rel)
				modeChanged := int64(stat.Mode&07777) != e.Mode
				switch e.Kind {
				case "directory":
					if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
						found.note(rel, "invalid-type-or-link")
						continue
					}
					if modeChanged {
						found.note(rel, "changed-mode")
					}
					sub, err := openCorePayloadDirectory(int(dir.Fd()), name)
					if err != nil {
						if !modeChanged {
							found.note(rel, "changed-during-observation")
						}
						continue
					}
					err = walk(sub, rel)
					sub.Close()
					if err != nil {
						return err
					}
				case "symlink":
					if stat.Mode&unix.S_IFMT != unix.S_IFLNK {
						found.note(rel, "invalid-type-or-link")
						continue
					}
					target := make([]byte, 4097)
					n, err := unix.Readlinkat(int(dir.Fd()), name, target)
					if err != nil || n == len(target) || string(target[:n]) != e.Link {
						found.note(rel, "changed-link")
					} else if modeChanged {
						found.note(rel, "changed-mode")
					}
				case "file":
					if stat.Mode&unix.S_IFMT != unix.S_IFREG {
						found.note(rel, "invalid-type-or-link")
						continue
					}
					if modeChanged {
						found.note(rel, "changed-mode")
						continue
					}
					if stat.Size != e.Size {
						found.note(rel, "changed-bytes")
						continue
					}
					fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
					if err != nil {
						reason := "unreadable"
						if err == unix.ENOENT || err == unix.ELOOP || err == unix.ENXIO {
							reason = "changed-during-observation"
						}
						found.note(rel, reason)
						continue
					}
					file := os.NewFile(uintptr(fd), name)
					var opened unix.Stat_t
					if unix.Fstat(fd, &opened) != nil || opened.Ino != stat.Ino || opened.Dev != stat.Dev || opened.Mode != stat.Mode || opened.Size != stat.Size {
						file.Close()
						found.note(rel, "changed-during-observation")
						continue
					}
					hash := sha256.New()
					n, err := io.CopyN(hash, file, e.Size)
					extra := make([]byte, 1)
					more, end := file.Read(extra)
					var after unix.Stat_t
					stable := unix.Fstat(fd, &after) == nil && opened.Ino == after.Ino && opened.Dev == after.Dev && opened.Mode == after.Mode && opened.Size == after.Size && opened.Mtim == after.Mtim && opened.Ctim == after.Ctim
					file.Close()
					switch {
					case err != nil && err != io.EOF:
						found.note(rel, "unreadable")
					case err != nil || n != e.Size || more != 0 || end != io.EOF || !stable:
						found.note(rel, "changed-during-observation")
					case fmt.Sprintf("%x", hash.Sum(nil)) != e.SHA256:
						found.note(rel, "changed-bytes")
					}
				}
			}
			if err == io.EOF {
				return nil
			}
		}
	}
	if err := walk(root, ""); err != nil {
		return found, err
	}
	missing := make([]string, 0, len(expected))
	for name := range expected {
		missing = append(missing, name)
	}
	sort.Strings(missing)
	for _, name := range missing {
		found.note(name, "missing-path")
	}
	if mode == CorePayloadStrict && found.Differs() {
		return found, &CorePayloadDifferenceError{Findings: found}
	}
	return found, nil
}
