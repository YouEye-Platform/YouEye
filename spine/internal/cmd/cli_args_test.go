package cmd

import (
	"errors"
	"os"
	"testing"

	"github.com/spf13/cobra"
	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
)

func TestValidateAppInstallArgs(t *testing.T) {
	ok := []struct {
		args                []string
		url                 string
		trusted, allowSetup bool
		source              string
	}{
		{[]string{"notes"}, "", false, false, ""},
		{[]string{"notes"}, "", false, false, "andrew-test"},
		{nil, "https://example.com/youeye-app.yaml", true, false, ""},
		{nil, "https://example.com/youeye-app.yaml", true, true, ""},
	}
	for _, c := range ok {
		if err := validateAppInstallArgs(c.args, c.url, c.trusted, c.allowSetup, c.source); err != nil {
			t.Errorf("%+v refused: %v", c, err)
		}
	}
	bad := []struct {
		args                []string
		url                 string
		trusted, allowSetup bool
		source              string
	}{
		{nil, "", false, false, ""},
		{[]string{"notes"}, "", false, true, ""},
		{[]string{"notes"}, "", true, false, ""},
		{[]string{"notes"}, "https://example.com/youeye-app.yaml", true, false, ""},
		{nil, "https://example.com/youeye-app.yaml", true, false, "andrew-test"},
	}
	for _, c := range bad {
		if err := validateAppInstallArgs(c.args, c.url, c.trusted, c.allowSetup, c.source); err == nil {
			t.Errorf("%+v accepted", c)
		}
	}
}

// Without --source the Control Panel picks the official Market; --source names one.
func TestInstallRequestSource(t *testing.T) {
	cmd := &cobra.Command{}
	cmd.Flags().Bool("public-access", false, "")
	if body := installRequest(cmd, "notes", ""); body["sourceId"] != nil || body["appId"] != "notes" {
		t.Fatalf("no --source must leave the source to the Control Panel: %v", body)
	}
	if body := installRequest(cmd, "notes", "andrew-test"); body["sourceId"] != "andrew-test" {
		t.Fatalf("--source must be sent: %v", body)
	}
}

func TestAppUpdateArgsAndPayload(t *testing.T) {
	if err := validateAppUpdateArgs(nil, true, true); err == nil {
		t.Error("--all --allow-setup accepted")
	}
	if err := validateAppUpdateArgs(nil, false, false); err == nil {
		t.Error("no app and no --all accepted")
	}
	if err := validateAppUpdateArgs([]string{"notes"}, false, true); err != nil {
		t.Errorf("update notes --allow-setup refused: %v", err)
	}
	if appUpdatePayload(false, false) != nil {
		t.Error("a plain update sends no body")
	}
	payload, _ := appUpdatePayload(false, true).(map[string]bool)
	if !payload["allowSetup"] || payload["confirm_switch"] {
		t.Errorf("--allow-setup payload: %v", payload)
	}
	payload, _ = appUpdatePayload(true, true).(map[string]bool)
	if !payload["allowSetup"] || !payload["confirm_switch"] {
		t.Errorf("-y --allow-setup payload: %v", payload)
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

func TestInstallAccessFieldsOnlyWhenFlagGiven(t *testing.T) {
	cmd := &cobra.Command{}
	var public bool
	cmd.Flags().BoolVar(&public, "public-access", false, "")
	appInstallPublic = false
	if body := installAccessFields(cmd, map[string]interface{}{"appId": "razzia"}); body["publicAccess"] != nil {
		t.Fatalf("no flag must leave the manifest default: %v", body)
	}
	if err := cmd.Flags().Set("public-access", "false"); err != nil {
		t.Fatal(err)
	}
	appInstallPublic = public
	if body := installAccessFields(cmd, map[string]interface{}{"appId": "razzia"}); body["publicAccess"] != false {
		t.Fatalf("--public-access=false must be sent: %v", body)
	}
	if err := cmd.Flags().Set("public-access", "true"); err != nil {
		t.Fatal(err)
	}
	appInstallPublic = public
	if body := installAccessFields(cmd, map[string]interface{}{"appId": "razzia"}); body["publicAccess"] != true {
		t.Fatalf("--public-access must be sent: %v", body)
	}
}

func TestAppCredentialsPathAndEntries(t *testing.T) {
	if got := appCredentialsPath("razzia"); got != "/api/market/credentials?app=razzia" {
		t.Fatalf("path = %q", got)
	}
	if got := appCredentialsPath("a b&c"); got != "/api/market/credentials?app=a+b%26c" {
		t.Fatalf("escaped path = %q", got)
	}
	entries := appCredentialEntries(map[string]interface{}{"credentials": []interface{}{
		map[string]interface{}{"label": "Admin", "username": "admin", "password": "fixture"},
		"not an object",
	}})
	if len(entries) != 1 || entries[0] != (appCredentialEntry{"Admin", "admin", "fixture"}) {
		t.Fatalf("entries = %+v", entries)
	}
	if len(appCredentialEntries(map[string]interface{}{"credentials": []interface{}{}})) != 0 {
		t.Fatal("an empty list must give no entries")
	}
}
