package cmd

import (
	"strings"
	"testing"
)

func TestAppRemoveMessageSuccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result map[string]interface{}
		want   string
	}{
		{
			name:   "default message",
			result: map[string]interface{}{"success": true},
			want:   "fixture-app removed",
		},
		{
			name:   "control panel message",
			result: map[string]interface{}{"success": true, "message": "fixture cleanup complete"},
			want:   "fixture cleanup complete",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := appRemoveMessage("fixture-app", tc.result)
			if err != nil {
				t.Fatalf("successful uninstall returned error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("message = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAppRemoveMessageFailure(t *testing.T) {
	result := map[string]interface{}{
		"success": false,
		"errors":  []interface{}{"dependency output with private-token-marker"},
	}

	message, err := appRemoveMessage("fixture-app", result)
	if err == nil {
		t.Fatal("success:false uninstall returned nil error")
	}
	if message != "" {
		t.Fatalf("success:false uninstall returned success message %q", message)
	}
	if strings.Contains(err.Error(), "private-token-marker") {
		t.Fatalf("uninstall error leaked response diagnostics: %v", err)
	}
	if strings.Contains(err.Error(), " removed") {
		t.Fatalf("uninstall error falsely claimed removal: %v", err)
	}
	if !strings.Contains(err.Error(), "some cleanup may have succeeded") {
		t.Fatalf("uninstall error did not retain partial-cleanup truth: %v", err)
	}
}

func TestAppRemoveMessageRequiresBooleanSuccess(t *testing.T) {
	for _, result := range []map[string]interface{}{
		{},
		{"success": "false"},
	} {
		message, err := appRemoveMessage("fixture-app", result)
		if err == nil || message != "" {
			t.Fatalf("invalid uninstall result returned message=%q error=%v", message, err)
		}
	}
}
