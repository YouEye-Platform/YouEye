package spineselect

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// DelegatedEnv marks a process the seed already handed to a selected Spine,
// so the selected binary never re-delegates.
const DelegatedEnv = "YOUEYE_SPINE_DELEGATED"

// SeedOnly lists commands that always run in the seed: they prepare State and
// storage before a selected Spine can be read, manage the selection, or
// recover a machine whose selected Spine is broken.
func SeedOnly(args []string) bool {
	if len(args) < 2 {
		return true
	}
	switch args[1] {
	case "recovery", "version", "--version", "-v", "help", "--help", "-h", "completion", "spine":
		return true
	case "appliance":
		return len(args) > 2 && args[2] == "prepare"
	}
	return false
}

// countsTrialStart reports whether this invocation is a start of the API
// service, which a trial Spine must survive to be committed.
func countsTrialStart(args []string) bool {
	return len(args) >= 3 && args[1] == "api" && args[2] == "serve"
}

// LaunchConfig describes the running process; tests override it.
type LaunchConfig struct {
	Args       []string
	Executable string
	Delegated  bool
	Appliance  bool
	Slot       string
	Root       string
	Host       Host
	Now        time.Time
}

// Decide returns the selected Spine to exec, or "" to keep running this binary.
func Decide(c LaunchConfig) (string, []string) {
	if c.Delegated || !c.Appliance || SeedOnly(c.Args) || !validSlot(c.Slot) {
		return "", nil
	}
	if filepath.Clean(c.Executable) != BakedPath {
		// Already a selected payload, a development overlay or a test binary.
		return "", nil
	}
	res, err := Resolve(c.Root, c.Slot, c.Host, countsTrialStart(c.Args), c.Now)
	notes := append([]string{}, res.Skipped...)
	if err != nil {
		notes = append(notes, err.Error())
	}
	return res.Path, notes
}

// BootedSlot reads the running System slot from the kernel command line.
var BootedSlot = func(slotFromCmdline func(string) (string, error)) string {
	raw, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return ""
	}
	slot, err := slotFromCmdline(string(raw))
	if err != nil {
		return ""
	}
	return slot
}

// MaybeDelegate execs the selected Spine when the seed runs on an appliance
// image. It returns only when this binary should continue.
func MaybeDelegate(manifestPath string, slotFromCmdline func(string) (string, error)) {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
		exe = resolved
	}
	_, statErr := os.Stat(manifestPath)
	delegated := os.Getenv(DelegatedEnv) != ""
	// Child commands (`youeye …` run by boot steps, deploy, scripts) must go
	// through the launcher again so they run the selected Spine too; only
	// BakedPath ever delegates, so dropping the marker cannot loop.
	os.Unsetenv(DelegatedEnv)
	path, notes := Decide(LaunchConfig{
		Args: os.Args, Executable: exe, Delegated: delegated,
		Appliance: statErr == nil, Slot: BootedSlot(slotFromCmdline), Root: DefaultRoot, Host: ThisHost(), Now: time.Now(),
	})
	for _, n := range notes {
		fmt.Fprintf(os.Stderr, "spine launcher: %s\n", n)
	}
	if path == "" {
		return
	}
	env := append(os.Environ(), DelegatedEnv+"=1")
	if err := syscall.Exec(path, os.Args, env); err != nil {
		fmt.Fprintf(os.Stderr, "spine launcher: running the seed; exec of the selected Spine failed: %v\n", err)
	}
}
