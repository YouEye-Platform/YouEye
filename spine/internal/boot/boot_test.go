package boot

import (
	"reflect"
	"strings"
	"testing"
)

func TestNamesListsTheEmbeddedBootSteps(t *testing.T) {
	want := []string{"bless", "first-deploy", "network", "setup-gate"}
	if got := Names(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Names() = %v, want %v", got, want)
	}
}

func TestScriptReturnsEachStep(t *testing.T) {
	for _, name := range Names() {
		script, err := Script(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !strings.HasPrefix(script, "#!") {
			t.Fatalf("%s is not a shell script: %.40q", name, script)
		}
	}
}

func TestScriptRejectsUnknownNames(t *testing.T) {
	for _, name := range []string{
		"", "unknown", "bless_test", "first-deploy_test", "network.sh",
		"../boot", "scripts/bless", "/bin/sh", "..", ".",
	} {
		if _, err := Script(name); err == nil {
			t.Fatalf("Script(%q) succeeded", name)
		}
		if _, err := Command(name, nil); err == nil {
			t.Fatalf("Command(%q) succeeded", name)
		}
	}
}

func TestCommandPassesTheScriptToShell(t *testing.T) {
	script, err := Script("network")
	if err != nil {
		t.Fatal(err)
	}
	cmd, err := Command("network", []string{"--check", "eth0"})
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != "/bin/sh" {
		t.Fatalf("Path = %q, want /bin/sh", cmd.Path)
	}
	want := []string{"/bin/sh", "-c", script, "youeye-network", "--check", "eth0"}
	if !reflect.DeepEqual(cmd.Args, want) {
		t.Fatalf("Args = %q, want %q", cmd.Args, want)
	}
	cmd, err = Command("bless", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd.Args) != 4 || cmd.Args[3] != "youeye-bless" {
		t.Fatalf("no-argument Args = %q", cmd.Args)
	}
}
