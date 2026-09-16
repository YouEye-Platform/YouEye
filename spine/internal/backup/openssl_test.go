package backup

import (
	"io"
	"strings"
	"testing"
)

func TestBackupPassphraseNeverAppearsInOpenSSLArguments(t *testing.T) {
	const passphrase = "sensitive backup phrase"
	cmd := opensslWithPassphrase(passphrase, "enc", "-aes-256-cbc", "-in", "input", "-out", "output")
	argv := strings.Join(cmd.Args, " ")
	if strings.Contains(argv, passphrase) || strings.Contains(argv, "pass:"+passphrase) {
		t.Fatalf("passphrase leaked into argv: %s", argv)
	}
	if !strings.Contains(argv, "-pass stdin") {
		t.Fatalf("openssl command does not select stdin: %s", argv)
	}
	got, err := io.ReadAll(cmd.Stdin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != passphrase+"\n" {
		t.Fatal("passphrase was not provided via stdin")
	}
}
