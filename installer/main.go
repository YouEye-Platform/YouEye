// Command youeye-installer is the YouEye platform installer.
//
// Run on a Proxmox VE host (it provisions a Debian VM and installs YouEye
// inside it) or on a bare Debian/Ubuntu host (it installs Spine + deploys
// YouEye directly). Interactive TUI by default.
package main

import (
	"fmt"
	"os"

	"git.potemk.in/potemsla/YouEye/installer/internal/installer"
)

func main() {
	// The TUI needs an interactive terminal. Bubble Tea opens /dev/tty as a
	// fallback for stdin, so we only require that /dev/tty exists (i.e. we are
	// not in a container/CI with no terminal at all).
	if _, err := os.Open("/dev/tty"); err != nil {
		fmt.Fprintln(os.Stderr, "The installer requires an interactive terminal (/dev/tty not available).")
		fmt.Fprintln(os.Stderr, "For non-interactive installs, run 'youeye deploy' on a bare host.")
		os.Exit(1)
	}

	if err := installer.Run(); err != nil {
		os.Exit(1)
	}
}
