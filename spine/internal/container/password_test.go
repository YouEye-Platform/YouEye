package container

import (
	"io"
	"strings"
	"testing"
)

func TestContainerRootPasswordNeverAppearsInArguments(t *testing.T) {
	const password = "sensitive-container-password"
	cmd := containerRootPasswordCommand("control", password)
	if strings.Contains(strings.Join(cmd.Args, " "), password) {
		t.Fatalf("password leaked into argv")
	}
	input, err := io.ReadAll(cmd.Stdin)
	if err != nil {
		t.Fatal(err)
	}
	if string(input) != "root:"+password+"\n" {
		t.Fatal("password was not transported through stdin")
	}
}
