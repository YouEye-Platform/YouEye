package consoleaccess

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Manager, *[]string, *[]int) {
	t.Helper()
	dir := t.TempDir()
	base := filepath.Join(dir, "base")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"passwd":  "root:x:0:0:root:/root:/bin/bash\nsshd:x:100:65534::/run/sshd:/usr/sbin/nologin\nbackup:x:34:34:backup:/var/backups:/usr/sbin/nologin\n",
		"shadow":  "root:*:20000:0:99999:7:::\nsshd:!:20000::::::\nbackup:*:20000:0:99999:7:::\n",
		"group":   "root:x:0:\nshadow:x:42:\nbackup:x:34:\n",
		"gshadow": "root:*::\nshadow:*::\nbackup:*::\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(base, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var mounts []string
	var terminated []int
	m := &Manager{
		RecordPath: filepath.Join(dir, "state", "bootstrap", "console-access.json"),
		BaseDir:    base,
		RunDir:     filepath.Join(dir, "run"),
		EtcDir:     filepath.Join(dir, "etc"),
		HomeRoot:   filepath.Join(dir, "state", "home"),
		SSHDropIn:  filepath.Join(dir, "etc", "ssh", "sshd_config.d", "90-youeye-console-access.conf"),
		ResetPath:  filepath.Join(dir, "state", "console", "owner-reset.json"),
		Mount: func(source, target string) error {
			mounts = append(mounts, filepath.Base(source)+">"+target)
			return nil
		},
		Terminate: func(uid int) { terminated = append(terminated, uid) },
		Reload:    func() error { return nil },
		Subnet:    func() string { return "192.168.31.0/24" },
		Now:       func() time.Time { return time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC) },
	}
	return m, &mounts, &terminated
}

func read(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestAdminsGetConsoleAccountsAndDemotionLocks(t *testing.T) {
	m, mounts, terminated := fixture(t)
	admins := []Admin{{UserID: "u-owner", Username: "Owner"}, {UserID: "u-2", Username: "backup"}, {UserID: "u-3", Username: "émile"}}
	if err := m.Change(func(r *Record, taken map[string]bool) error { return r.Sync(admins, taken) }); err != nil {
		t.Fatal(err)
	}
	if err := m.Change(func(r *Record, _ map[string]bool) error { return r.SetPassword("u-owner", "correct horse battery") }); err != nil {
		t.Fatal(err)
	}
	status, err := m.Status()
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]AccountStatus{}
	for _, a := range status.Accounts {
		names[a.UserID] = a
	}
	// A name the image uses, or one that isn't a valid Linux name, maps to ye-<name>.
	if names["u-owner"].Username != "owner" || names["u-2"].Username != "ye-backup" || names["u-3"].Username != "ye-mile" {
		t.Fatalf("username mapping: %+v", status.Accounts)
	}
	if !status.Claimed {
		t.Fatal("an admin sync must mark the box claimed")
	}
	if names["u-owner"].Locked || !names["u-2"].Locked || !names["u-2"].Admin {
		t.Fatalf("an admin without a password stays locked: %+v", status.Accounts)
	}
	passwd, shadow, group := read(t, filepath.Join(m.RunDir, "passwd")), read(t, filepath.Join(m.RunDir, "shadow")), read(t, filepath.Join(m.RunDir, "group"))
	if !strings.Contains(passwd, "sshd:x:100:") || !strings.Contains(passwd, "owner:x:2001:2000:YouEye admin:") {
		t.Fatalf("passwd: %s", passwd)
	}
	if !strings.Contains(shadow, "root:!:") || !strings.Contains(shadow, "owner:$y$") || !strings.Contains(shadow, "ye-backup:!:") {
		t.Fatalf("shadow: %s", shadow)
	}
	if !strings.Contains(group, "youeye-admins:x:2000:owner\n") || !strings.Contains(group, "shadow:x:42:") {
		t.Fatalf("group: %s", group)
	}
	if len(*mounts) != 8 || !strings.HasSuffix((*mounts)[0], filepath.Join(m.EtcDir, "passwd")) {
		t.Fatalf("mounts: %v", *mounts)
	}
	if info, err := os.Stat(filepath.Join(m.HomeRoot, "owner")); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("home: %v %v", info, err)
	}
	// Demoting (the admin is missing from the next sync) locks at once and
	// ends sessions; the uid stays reserved.
	*terminated = nil
	if err := m.Change(func(r *Record, taken map[string]bool) error { return r.Sync(admins[1:], taken) }); err != nil {
		t.Fatal(err)
	}
	if passwd := read(t, filepath.Join(m.RunDir, "passwd")); strings.Contains(passwd, "owner:x:") {
		t.Fatalf("demoted admin still has a host account: %s", passwd)
	}
	if !contains(*terminated, 2001) {
		t.Fatalf("demoted admin's sessions not ended: %v", *terminated)
	}
	if err := m.Change(func(r *Record, _ map[string]bool) error { return r.SetPassword("u-owner", "another password") }); err == nil {
		t.Fatal("a former admin got a console password")
	}
	// Promoted again: same name and uid, but locked until a new password
	// arrives (the old one may have leaked meanwhile).
	if err := m.Change(func(r *Record, taken map[string]bool) error { return r.Sync(admins, taken) }); err != nil {
		t.Fatal(err)
	}
	if passwd, shadow := read(t, filepath.Join(m.RunDir, "passwd")), read(t, filepath.Join(m.RunDir, "shadow")); !strings.Contains(passwd, "owner:x:2001:") || !strings.Contains(shadow, "owner:!:") {
		t.Fatalf("re-promoted admin: %s\n%s", passwd, shadow)
	}
	// A password the CP couldn't deliver is cleared, so an old one stops working.
	if err := m.Change(func(r *Record, _ map[string]bool) error { return r.SetPassword("u-owner", "correct horse battery") }); err != nil {
		t.Fatal(err)
	}
	if err := m.Change(func(r *Record, _ map[string]bool) error { r.ClearPassword("u-owner"); return nil }); err != nil {
		t.Fatal(err)
	}
	if shadow := read(t, filepath.Join(m.RunDir, "shadow")); !strings.Contains(shadow, "owner:!:") {
		t.Fatalf("cleared password still works: %s", shadow)
	}
}

func TestRootPasswordAndPasswordSSH(t *testing.T) {
	m, _, _ := fixture(t)
	if err := m.Change(func(r *Record, _ map[string]bool) error {
		hash, err := HashPassword("root password!")
		r.RootPasswordHash, r.PasswordSSH = hash, true
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if shadow := read(t, filepath.Join(m.RunDir, "shadow")); !strings.HasPrefix(shadow, "root:$y$") {
		t.Fatalf("root hash not applied: %s", shadow)
	}
	dropIn := read(t, m.SSHDropIn)
	if !strings.Contains(dropIn, "Match Group youeye-admins Address 192.168.31.0/24") || !strings.Contains(dropIn, "Match User root Address 192.168.31.0/24") {
		t.Fatalf("drop-in: %s", dropIn)
	}
	if err := m.Change(func(r *Record, _ map[string]bool) error { r.PasswordSSH = false; return nil }); err != nil {
		t.Fatal(err)
	}
	// Without password SSH only the rule that admins never use key files stays.
	if dropIn := read(t, m.SSHDropIn); strings.Contains(dropIn, "PasswordAuthentication") || !strings.Contains(dropIn, "Match Group youeye-admins\n    AuthorizedKeysFile none") {
		t.Fatalf("drop-in after password SSH off: %s", dropIn)
	}
	if _, err := HashPassword("short"); err == nil {
		t.Fatal("short password accepted")
	}
}

func TestRecordKeepsNewerFields(t *testing.T) {
	m, _, _ := fixture(t)
	if err := os.MkdirAll(filepath.Dir(m.RecordPath), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{"schema":"youeye.console-access.v1","password_ssh":false,"passkeys":true,"accounts":[{"user_id":"u1","username":"anna","uid":2001,"admin":true,"locked":true,"shell":"zsh"}]}`
	if err := os.WriteFile(m.RecordPath, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.Change(func(r *Record, _ map[string]bool) error { return r.SetPassword("u1", "a long password") }); err != nil {
		t.Fatal(err)
	}
	kept := read(t, m.RecordPath)
	if !strings.Contains(kept, `"passkeys": true`) || !strings.Contains(kept, `"password_hash": "$y$`) || !strings.Contains(kept, `"shell": "zsh"`) {
		t.Fatalf("record lost a newer key: %s", kept)
	}
}

func TestOwnerResetCode(t *testing.T) {
	m, _, _ := fixture(t)
	code, err := m.IssueResetCode()
	if err != nil {
		t.Fatal(err)
	}
	if shown := strings.TrimSpace(read(t, m.CodePath())); shown != code || len(code) != 11 {
		t.Fatalf("console code %q vs %q", shown, code)
	}
	if status, _ := m.Status(); !status.ResetPending {
		t.Fatal("reset not pending")
	}
	if err := m.UseResetCode("WRONG-CODE1"); err != ErrResetCode {
		t.Fatal(err)
	}
	// Case, spaces and the dash don't matter; the code works once.
	if err := m.UseResetCode(" " + strings.ToLower(strings.ReplaceAll(code, "-", " ")) + " "); err != nil {
		t.Fatal(err)
	}
	if err := m.UseResetCode(code); err != ErrResetCode {
		t.Fatal("code reused")
	}
	// Ten wrong tries pause it for 15 minutes (never void it: nobody can stop
	// the owner's reset by guessing); an expired code is void.
	code, _ = m.IssueResetCode()
	for i := 0; i < 10; i++ {
		_ = m.UseResetCode("AAAAA-AAAAA")
	}
	if err := m.UseResetCode(code); err != ErrResetCode {
		t.Fatal("code accepted during the pause")
	}
	now := m.Now
	m.Now = func() time.Time { return now().Add(16 * time.Minute) }
	if err := m.UseResetCode(code); err != nil {
		t.Fatalf("code refused after the pause: %v", err)
	}
	m.Now = now
	code, _ = m.IssueResetCode()
	m.Now = func() time.Time { return time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC) }
	if err := m.UseResetCode(code); err != ErrResetCode {
		t.Fatal("expired code accepted")
	}
}

func contains(list []int, value int) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}

// One account this Spine can't use (a newer hash format, say) must not lock
// the other admins out; it is kept as written and its name and uid stay taken.
func TestUnusableAccountIsSkippedAndKept(t *testing.T) {
	m, _, _ := fixture(t)
	if err := os.MkdirAll(filepath.Dir(m.RecordPath), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{"schema":"youeye.console-access.v1","root_password_hash":"$argon2id$future","password_ssh":false,"accounts":[
	 {"user_id":"u1","username":"anna","uid":2001,"admin":true,"locked":true},
	 {"user_id":"u2","username":"ben","uid":2002,"password_hash":"$argon2id$v=19$future","admin":true,"locked":false}]}`
	if err := os.WriteFile(m.RecordPath, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.Change(func(r *Record, _ map[string]bool) error { return r.SetPassword("u1", "a long password") }); err != nil {
		t.Fatal(err)
	}
	if err := m.Change(func(r *Record, taken map[string]bool) error {
		return r.Sync([]Admin{{UserID: "u1", Username: "anna"}, {UserID: "u2", Username: "ben"}, {UserID: "u3", Username: "ben"}}, taken)
	}); err != nil {
		t.Fatal(err)
	}
	kept := read(t, m.RecordPath)
	if !strings.Contains(kept, `$argon2id$v=19$future`) || !strings.Contains(kept, `"root_password_hash": "$argon2id$future"`) {
		t.Fatalf("unusable entries were not kept: %s", kept)
	}
	passwd, shadow := read(t, filepath.Join(m.RunDir, "passwd")), read(t, filepath.Join(m.RunDir, "shadow"))
	if !strings.Contains(passwd, "anna:x:2001:") || strings.Contains(passwd, "ben:x:2002:") || !strings.Contains(passwd, "ye-ben:x:2003:") || !strings.HasPrefix(shadow, "root:!:") {
		t.Fatalf("passwd/shadow: %s\n%s", passwd, shadow)
	}
	// The unreadable account's own admin (u2) never gets a second account; the
	// status shows it as unsupported. Demoting u2 locks it in the kept entry.
	if err := m.Change(func(r *Record, taken map[string]bool) error {
		return r.Sync([]Admin{{UserID: "u1", Username: "anna"}, {UserID: "u2", Username: "ben"}, {UserID: "u3", Username: "ben"}}, taken)
	}); err != nil {
		t.Fatal(err)
	}
	status, _ := m.Status()
	count := 0
	for _, a := range status.Accounts {
		if a.UserID == "u2" {
			count++
			if !a.Unsupported {
				t.Fatalf("u2 should be unsupported: %+v", a)
			}
		}
	}
	if count != 1 {
		t.Fatalf("u2 got %d accounts: %+v", count, status.Accounts)
	}
	if err := m.Change(func(r *Record, taken map[string]bool) error {
		return r.Sync([]Admin{{UserID: "u1", Username: "anna"}, {UserID: "u3", Username: "ben"}}, taken)
	}); err != nil {
		t.Fatal(err)
	}
	if kept := read(t, m.RecordPath); strings.Contains(kept, `$argon2id$v=19$future`) || !strings.Contains(kept, `"claimed": true`) {
		t.Fatalf("demoted unreadable account kept its hash, or claimed missing: %s", kept)
	}
}

// A newer image may add a system user with an admin's name: the image wins.
func TestAccountClashingWithImageUserIsSkipped(t *testing.T) {
	m, _, terminated := fixture(t)
	if err := m.Change(func(r *Record, taken map[string]bool) error {
		return r.Sync([]Admin{{UserID: "u1", Username: "postgres"}}, taken)
	}); err != nil {
		t.Fatal(err)
	}
	if err := m.Change(func(r *Record, _ map[string]bool) error { return r.SetPassword("u1", "a long password") }); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(m.BaseDir, "passwd")
	if err := os.WriteFile(base, []byte(read(t, base)+"postgres:x:110:110::/var/lib/postgresql:/bin/bash\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.Apply(); err != nil {
		t.Fatal(err)
	}
	passwd := read(t, filepath.Join(m.RunDir, "passwd"))
	if strings.Count(passwd, "postgres:") != 1 || strings.Contains(passwd, "postgres:x:2001") || !contains(*terminated, 2001) {
		t.Fatalf("clash not resolved for the image: %s", passwd)
	}
	if info, err := os.Stat(m.HomeRoot); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("home root must be traversable: %v %v", info, err)
	}
}
