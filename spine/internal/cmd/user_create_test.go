package cmd

import (
	"os"
	"strings"
	"testing"
)

func TestUserCreatePasswordStdinNeverPrompts(t *testing.T) {
	if err := userCreateStdinCheck(true, "Std", "std@example.test"); err != nil {
		t.Fatalf("complete flags refused: %v", err)
	}
	if err := userCreateStdinCheck(true, "", "std@example.test"); err == nil {
		t.Fatal("a missing first name would be asked for on stdin, which holds the password")
	}
	if err := userCreateStdinCheck(true, "Std", ""); err == nil {
		t.Fatal("a missing email would be asked for on stdin, which holds the password")
	}
	if err := userCreateStdinCheck(false, "", ""); err != nil {
		t.Fatalf("interactive creation refused: %v", err)
	}
	source, err := os.ReadFile("user.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), `!cmd.Flags().Changed("last-name") && !userCreatePasswordStdin`) {
		t.Fatal("the optional last name is asked for on stdin although stdin is the password")
	}
}

func TestBackupSizeText(t *testing.T) {
	for value, want := range map[float64]string{477893371: "456 MiB", 3 << 30: "3.0 GiB", 2048: "2 KiB"} {
		if got := backupSizeText(value); got != want {
			t.Errorf("backupSizeText(%v) = %q, want %q", value, got, want)
		}
	}
	if got := backupSizeText(nil); got != "" {
		t.Errorf("a missing size printed %q", got)
	}
}

func TestCreatedUsername(t *testing.T) {
	answer := map[string]interface{}{"success": true, "user": map[string]interface{}{"username": "anna"}}
	if got := createdUsername(answer, "Anna"); got != "anna" {
		t.Errorf("createdUsername = %q, want the Control Panel's name", got)
	}
	if got := createdUsername(map[string]interface{}{"success": true}, "anna"); got != "anna" {
		t.Errorf("createdUsername without a user = %q, want the asked name", got)
	}
}
