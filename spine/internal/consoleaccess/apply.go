package consoleaccess

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Manager applies the record to the host. The paths are fields so tests can
// run it in a directory tree.
type Manager struct {
	RecordPath string // bootstrap/console-access.json on State
	BaseDir    string // the image's own passwd, shadow, group, gshadow
	RunDir     string // generated files (tmpfs)
	EtcDir     string // where they are bind-mounted
	HomeRoot   string // admins' home directories (on State)
	SSHDropIn  string // sshd_config.d drop-in for password SSH
	ResetPath  string // owner reset code record (on State)
	// Mount binds source over target unless target is already a mount of it;
	// Reload applies a changed sshd drop-in; Subnet finds the local IPv4 subnet.
	Mount func(source, target string) error
	// Terminate ends the sessions of a uid whose account was just locked.
	Terminate func(uid int)
	Reload    func() error
	Subnet    func() string
	Now       func() time.Time
}

// Default is the installed appliance.
func Default() *Manager {
	return &Manager{
		RecordPath: "/var/lib/youeye-state/bootstrap/console-access.json",
		BaseDir:    "/usr/lib/youeye/etc-base",
		RunDir:     "/run/youeye/console",
		EtcDir:     "/etc",
		HomeRoot:   "/var/lib/youeye-state/home",
		SSHDropIn:  "/etc/ssh/sshd_config.d/90-youeye-console-access.conf",
		ResetPath:  "/var/lib/youeye-state/console/owner-reset.json",
		Mount:      bindMount,
		Terminate:  terminateUser,
		Reload:     reloadSSH,
		Subnet:     localSubnet,
		Now:        time.Now,
	}
}

var accountFiles = []struct {
	name string
	mode os.FileMode
}{{"passwd", 0o644}, {"group", 0o644}, {"shadow", 0o640}, {"gshadow", 0o640}}

// Taken returns the user and group names the image defines.
func (m *Manager) Taken() (map[string]bool, error) {
	taken := map[string]bool{}
	for _, name := range []string{"passwd", "group"} {
		lines, err := readLines(filepath.Join(m.BaseDir, name))
		if err != nil {
			return nil, err
		}
		for _, line := range lines {
			if field, _, ok := strings.Cut(line, ":"); ok {
				taken[field] = true
			}
		}
	}
	return taken, nil
}

// lock serialises every change to the record, the host files and the reset
// code across processes (the API, boot, Recovery's applier).
func (m *Manager) lock() (func(), error) {
	if err := os.MkdirAll(filepath.Dir(m.RecordPath), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(m.RecordPath+".lock", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		file.Close()
		return nil, err
	}
	return func() { file.Close() }, nil
}

// Apply builds the account files from the image's copies plus the record and
// makes them the host's, creates admins' homes, and converges SSH.
func (m *Manager) Apply() error {
	unlock, err := m.lock()
	if err != nil {
		return err
	}
	defer unlock()
	return m.apply()
}

// apply is Apply with the lock held. The files are rewritten in place (a bind
// mount follows the inode); they live on tmpfs and are rebuilt at every boot.
func (m *Manager) apply() error {
	record, err := Load(m.RecordPath)
	if err != nil {
		return err
	}
	files, err := m.render(record)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(m.RunDir, 0o755); err != nil {
		return err
	}
	shadowGID := -1
	if gid, ok := groupID(files["group"], "shadow"); ok {
		shadowGID = gid
	}
	for _, f := range accountFiles {
		path := filepath.Join(m.RunDir, f.name)
		// Rewrite in place: a bind mount follows the inode, not the name.
		if err := os.WriteFile(path, files[f.name], f.mode); err != nil {
			return err
		}
		if err := os.Chmod(path, f.mode); err != nil {
			return err
		}
		if f.mode == 0o640 && shadowGID >= 0 {
			if err := os.Chown(path, 0, shadowGID); err != nil {
				return err
			}
		}
		if err := m.Mount(path, filepath.Join(m.EtcDir, f.name)); err != nil {
			return fmt.Errorf("bind %s: %w", f.name, err)
		}
	}
	if err := os.MkdirAll(m.HomeRoot, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(m.HomeRoot, 0o755); err != nil {
		return err
	}
	taken, err := m.Taken()
	if err != nil {
		return err
	}
	for _, a := range record.Accounts {
		if !a.Admin || a.Locked || taken[a.Username] {
			m.Terminate(a.UID)
		}
		if !a.Admin || taken[a.Username] {
			continue
		}
		home := filepath.Join(m.HomeRoot, a.Username)
		if err := os.Mkdir(home, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		if err := os.Chown(home, a.UID, AdminGID); err != nil {
			return err
		}
	}
	return m.applySSH(record)
}

func (m *Manager) render(record Record) (map[string][]byte, error) {
	base := map[string][]string{}
	for _, f := range accountFiles {
		lines, err := readLines(filepath.Join(m.BaseDir, f.name))
		if err != nil {
			return nil, fmt.Errorf("the image's %s is missing: %w", f.name, err)
		}
		base[f.name] = lines
	}
	days := strconv.FormatInt(m.Now().Unix()/86400, 10)
	var members []string
	out := map[string]*bytes.Buffer{}
	for _, f := range accountFiles {
		out[f.name] = &bytes.Buffer{}
	}
	for _, line := range base["passwd"] {
		fmt.Fprintln(out["passwd"], line)
	}
	taken := map[string]bool{}
	for _, name := range []string{"passwd", "group"} {
		for _, line := range base[name] {
			if field, _, ok := strings.Cut(line, ":"); ok {
				taken[field] = true
			}
		}
	}
	for _, line := range base["shadow"] {
		fields := strings.Split(line, ":")
		if len(fields) > 1 && fields[0] == "root" {
			fields[1] = "!"
			if ValidHash(record.RootPasswordHash) {
				fields[1] = record.RootPasswordHash
			}
			line = strings.Join(fields, ":")
		}
		fmt.Fprintln(out["shadow"], line)
	}
	for _, a := range record.Accounts {
		// A newer image may define a system user with an admin's name: the
		// image wins and the account stays off until it is renamed.
		if !a.Admin || taken[a.Username] {
			continue
		}
		hash := a.PasswordHash
		if hash == "" || a.Locked {
			hash = "!" + hash
		} else {
			members = append(members, a.Username)
		}
		home := filepath.Join(m.HomeRoot, a.Username)
		fmt.Fprintf(out["passwd"], "%s:x:%d:%d:YouEye admin:%s:/bin/bash\n", a.Username, a.UID, AdminGID, home)
		fmt.Fprintf(out["shadow"], "%s:%s:%s:0:99999:7:::\n", a.Username, hash, days)
	}
	for _, line := range base["group"] {
		fmt.Fprintln(out["group"], line)
	}
	for _, line := range base["gshadow"] {
		fmt.Fprintln(out["gshadow"], line)
	}
	fmt.Fprintf(out["group"], "%s:x:%d:%s\n", AdminGroup, AdminGID, strings.Join(members, ","))
	fmt.Fprintf(out["gshadow"], "%s:!::%s\n", AdminGroup, strings.Join(members, ","))
	files := map[string][]byte{}
	for name, buf := range out {
		files[name] = buf.Bytes()
	}
	return files, nil
}

func (m *Manager) applySSH(record Record) error {
	// Admins sign in by password only: a key file left in a home (from a
	// former owner after a factory reset, say) must never let anyone in.
	content := "# Managed by YouEye console access.\nMatch Group " + AdminGroup + "\n    AuthorizedKeysFile none\n"
	if record.PasswordSSH {
		if scope := m.Subnet(); scope != "" {
			content += "# Password SSH from the local subnet only.\n" +
				"Match Group " + AdminGroup + " Address " + scope + "\n    PasswordAuthentication yes\n    KbdInteractiveAuthentication no\n"
			if ValidHash(record.RootPasswordHash) {
				content += "Match User root Address " + scope + "\n    PasswordAuthentication yes\n    PermitRootLogin yes\n"
			}
		}
	}
	previous, err := os.ReadFile(m.SSHDropIn)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && string(previous) == content {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(m.SSHDropIn), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(m.SSHDropIn, []byte(content), 0o600); err != nil {
		return err
	}
	return m.Reload()
}

func readLines(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var lines []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if line := strings.TrimRight(scanner.Text(), "\r"); line != "" {
			lines = append(lines, line)
		}
	}
	return lines, scanner.Err()
}

func groupID(group []byte, name string) (int, bool) {
	for _, line := range strings.Split(string(group), "\n") {
		fields := strings.Split(line, ":")
		if len(fields) >= 3 && fields[0] == name {
			gid, err := strconv.Atoi(fields[2])
			return gid, err == nil
		}
	}
	return 0, false
}

func bindMount(source, target string) error {
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if fields := strings.Fields(line); len(fields) > 4 && fields[4] == target {
			return nil // already bound; its content was rewritten in place
		}
	}
	if out, err := exec.Command("mount", "--bind", source, target).CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func terminateUser(uid int) {
	_ = exec.Command("loginctl", "terminate-user", strconv.Itoa(uid)).Run()
	_ = exec.Command("pkill", "-KILL", "-U", strconv.Itoa(uid)).Run()
}

func reloadSSH() error {
	if out, err := exec.Command("/usr/sbin/sshd", "-t").CombinedOutput(); err != nil {
		return fmt.Errorf("sshd refused the console access drop-in: %s", strings.TrimSpace(string(out)))
	}
	return exec.Command("systemctl", "--no-block", "try-reload-or-restart", "ssh.service").Run()
}

// localSubnet is the directly connected IPv4 subnet of the default route's
// interface ("" when there is none).
func localSubnet() string {
	out, err := exec.Command("ip", "-4", "route", "show", "default").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	device := ""
	for i := 0; i+1 < len(fields); i++ {
		if fields[i] == "dev" {
			device = fields[i+1]
			break
		}
	}
	if device == "" {
		return ""
	}
	out, err = exec.Command("ip", "-4", "route", "show", "dev", device, "scope", "link").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if f := strings.Fields(line); len(f) > 0 && strings.Contains(f[0], "/") && f[0] != "default" {
			return f[0]
		}
	}
	return ""
}
