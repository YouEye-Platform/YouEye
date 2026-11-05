package systemupdate

import (
	"strings"
	"testing"
)

func TestIndependentCopyPiholePreflightRejectsSeparateAuthority(t *testing.T) {
	standard := `[webserver.api]
pwhash = "synthetic-source-hash"
app_pwhash = ""
totp_secret = ""
[dns]
blocking = true
`
	if err := validateCopyPiholeConfiguration([]byte(standard)); err != nil {
		t.Fatal(err)
	}
	for _, config := range []string{strings.Replace(standard, `app_pwhash = ""`, `app_pwhash = "extra-client"`, 1), strings.Replace(standard, `totp_secret = ""`, `totp_secret = "extra-factor"`, 1), strings.Replace(standard, `pwhash = "synthetic-source-hash"`, `pwhash = ""`, 1), "[dns]\nblocking = true"} {
		if err := validateCopyPiholeConfiguration([]byte(config)); err == nil {
			t.Fatal("unsupported inherited authority accepted")
		}
	}
}
