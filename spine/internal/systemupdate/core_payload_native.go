package systemupdate

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// This reference verifier is used by fixtures only. Installed truth is observed
// from the host, never by asking the potentially modified container runtime.
//
//go:embed core_payload_verify.cjs
var corePayloadVerifier string
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
func VerifyCoreContainerPayload(ctx context.Context, container, appDir string, index CorePayloadIndex) error {
	return verifyCoreContainerPayload(ctx, container, appDir, index, nativeCoreContainerPID)
}

func verifyCoreContainerPayload(ctx context.Context, container, appDir string, index CorePayloadIndex, observe func(context.Context, string) (int, error)) error {
	if err := index.Validate(); err != nil {
		return err
	}
	if !coreContainerName.MatchString(container) || !filepath.IsAbs(appDir) || filepath.Clean(appDir) != appDir || appDir == "/" || strings.ContainsAny(appDir, "\x00\r\n\\") {
		return fmt.Errorf("exact core container and application directory required")
	}
	pid, err := observe(ctx, container)
	if err != nil {
		return err
	}
	identity, err := nativeProcessIdentity(pid)
	if err != nil {
		return fmt.Errorf("core container process unavailable")
	}
	root, err := os.Open(fmt.Sprintf("/proc/%d/root", pid))
	if err != nil {
		return fmt.Errorf("core container filesystem unavailable")
	}
	defer root.Close()
	// Each path component is opened without following links; ancestor replacement
	// cannot redirect subsequent reads outside the anchored filesystem.
	dir, err := openCorePayloadDirectory(int(root.Fd()), strings.TrimPrefix(appDir, "/"))
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := verifyCorePayloadDescriptor(ctx, dir, index); err != nil {
		return err
	}
	current, err := observe(ctx, container)
	if err != nil || current != pid {
		return fmt.Errorf("core container changed during observation")
	}
	after, err := nativeProcessIdentity(pid)
	if err != nil || after != identity {
		return fmt.Errorf("core container process changed during observation")
	}
	return nil
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

func verifyCorePayloadDescriptor(ctx context.Context, root *os.File, index CorePayloadIndex) error {
	expected := make(map[string]CorePayloadEntry, len(index.Entries))
	for _, e := range index.Entries {
		expected[e.Path] = e
	}
	seen := 0
	var walk func(*os.File, string) error
	walk = func(dir *os.File, prefix string) error {
		for {
			children, err := dir.ReadDir(128)
			if err != nil && err != io.EOF {
				return fmt.Errorf("core directory observation failed")
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
					return fmt.Errorf("installed core contains an unrecorded path")
				}
				var stat unix.Stat_t
				if unix.Fstatat(int(dir.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW) != nil || int64(stat.Mode&07777) != e.Mode {
					return fmt.Errorf("installed core mode changed")
				}
				switch e.Kind {
				case "directory":
					if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
						return fmt.Errorf("installed core directory changed")
					}
					sub, err := openCorePayloadDirectory(int(dir.Fd()), name)
					if err != nil {
						return err
					}
					err = walk(sub, rel)
					sub.Close()
					if err != nil {
						return err
					}
				case "symlink":
					if stat.Mode&unix.S_IFMT != unix.S_IFLNK {
						return fmt.Errorf("installed core link changed")
					}
					target := make([]byte, 4097)
					n, err := unix.Readlinkat(int(dir.Fd()), name, target)
					if err != nil || n == len(target) || string(target[:n]) != e.Link {
						return fmt.Errorf("installed core link changed")
					}
				case "file":
					if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Size != e.Size {
						return fmt.Errorf("installed core file changed")
					}
					fd, err := unix.Openat(int(dir.Fd()), name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
					if err != nil {
						return fmt.Errorf("installed core file unavailable")
					}
					file := os.NewFile(uintptr(fd), name)
					var opened unix.Stat_t
					if unix.Fstat(fd, &opened) != nil || opened.Ino != stat.Ino || opened.Dev != stat.Dev || opened.Mode != stat.Mode || opened.Size != stat.Size {
						file.Close()
						return fmt.Errorf("installed core file changed during observation")
					}
					hash := sha256.New()
					n, err := io.CopyN(hash, file, e.Size)
					extra := make([]byte, 1)
					more, end := file.Read(extra)
					var after unix.Stat_t
					stable := unix.Fstat(fd, &after) == nil && opened.Ino == after.Ino && opened.Dev == after.Dev && opened.Mode == after.Mode && opened.Size == after.Size && opened.Mtim == after.Mtim && opened.Ctim == after.Ctim
					file.Close()
					if err != nil || n != e.Size || more != 0 || end != io.EOF || !stable || fmt.Sprintf("%x", hash.Sum(nil)) != e.SHA256 {
						return fmt.Errorf("installed core bytes changed")
					}
				}
				delete(expected, rel)
				seen++
			}
			if err == io.EOF {
				break
			}
		}
		return nil
	}
	if err := walk(root, ""); err != nil {
		return err
	}
	if seen != len(index.Entries) || len(expected) != 0 {
		return fmt.Errorf("installed core is missing recorded paths")
	}
	return nil
}
