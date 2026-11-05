package backup

import (
	"os/exec"
	"strings"
)

// opensslWithPassphrase passes the secret over stdin. argv contains only the
// literal OpenSSL password source "stdin", never the passphrase itself.
func opensslWithPassphrase(passphrase string, args ...string) *exec.Cmd {
	args = append(args, "-pass", "stdin")
	cmd := exec.Command("openssl", args...)
	cmd.Stdin = strings.NewReader(passphrase + "\n")
	return cmd
}
