package cmd

import (
	"errors"
	"os"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
)

func TestValidateAppInstallArgs(t *testing.T) {
	ok := []struct {
		args                []string
		url                 string
		trusted, allowSetup bool
	}{
		{[]string{"notes"}, "", false, false},
		{nil, "https://example.com/youeye-app.yaml", true, false},
		{nil, "https://example.com/youeye-app.yaml", true, true},
	}
	for _, c := range ok {
		if err := validateAppInstallArgs(c.args, c.url, c.trusted, c.allowSetup); err != nil {
			t.Errorf("%+v refused: %v", c, err)
		}
	}
	bad := []struct {
		args                []string
		url                 string
		trusted, allowSetup bool
	}{
		{nil, "", false, false},
		{[]string{"notes"}, "", false, true},
		{[]string{"notes"}, "", true, false},
		{[]string{"notes"}, "https://example.com/youeye-app.yaml", true, false},
	}
	for _, c := range bad {
		if err := validateAppInstallArgs(c.args, c.url, c.trusted, c.allowSetup); err == nil {
			t.Errorf("%+v accepted", c)
		}
	}
}

// An unreachable Control Panel (or a missing CLI token) must fail the command, not exit 0.
func TestRequireCPFailsWithExitCode(t *testing.T) {
	if _, err := os.Stat(controlapi.CLITokenPath); err == nil {
		t.Skip("a real CLI token exists on this machine")
	}
	old := controlClient
	controlClient = nil
	t.Cleanup(func() { controlClient = old })
	err := requireCP()
	var exit *ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || exit.Error() != "" {
		t.Fatalf("requireCP without a token: %#v", err)
	}
}
