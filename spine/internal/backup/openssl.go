package backup

import (
	"context"
	"os/exec"
	"strings"
)

// opensslWithPassphrase passes the secret over stdin. argv contains only the
// literal OpenSSL password source "stdin", never the passphrase itself.
func opensslWithPassphrase(passphrase string, args ...string) *exec.Cmd {
	return opensslStep(context.Background(), passphrase, args...)
}

// opensslStep is opensslWithPassphrase for a step that ends with ctx (stepCommand).
func opensslStep(ctx context.Context, passphrase string, args ...string) *exec.Cmd {
	args = append(args, "-pass", "stdin")
	cmd := stepCommand(ctx, "openssl", args...)
	cmd.Stdin = strings.NewReader(passphrase + "\n")
	return cmd
}
