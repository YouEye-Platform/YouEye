// Package boot carries the appliance's boot orchestration (first deployment,
// boot blessing, the setup gate and the network check) inside Spine, so a
// change to it ships as a Spine release instead of an image rebuild. Units run
// `youeye boot <name>`; only what must run before State is mounted (initramfs)
// stays baked into the image.
package boot

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"sort"
	"strings"
)

//go:embed scripts/first-deploy.sh scripts/bless.sh scripts/setup-gate.sh scripts/network.sh
var scripts embed.FS

// Names lists the embedded boot scripts.
func Names() []string {
	entries, _ := fs.Glob(scripts, "scripts/*.sh")
	var names []string
	for _, e := range entries {
		name := strings.TrimSuffix(strings.TrimPrefix(e, "scripts/"), ".sh")
		if !strings.HasSuffix(name, "_test") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// Script returns the embedded script for name.
func Script(name string) (string, error) {
	if strings.ContainsAny(name, "/.") || strings.HasSuffix(name, "_test") {
		return "", fmt.Errorf("unknown boot step %q", name)
	}
	raw, err := scripts.ReadFile("scripts/" + name + ".sh")
	if err != nil {
		return "", fmt.Errorf("unknown boot step %q (known: %s)", name, strings.Join(Names(), ", "))
	}
	return string(raw), nil
}

// Command runs an embedded script with /bin/sh: the script text is passed as
// an argument, so nothing is written to (noexec) /run or State.
func Command(name string, args []string) (*exec.Cmd, error) {
	script, err := Script(name)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("/bin/sh", append([]string{"-c", script, "youeye-" + name}, args...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd, nil
}
