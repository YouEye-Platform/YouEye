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

func TestAppRemoveConnectionsLeft(t *testing.T) {
	result := map[string]interface{}{
		"success": true,
		"connectionsLeft": []interface{}{
			map[string]interface{}{"appId": "sonarr", "name": "Sonarr"},
			map[string]interface{}{"appId": "sonarr", "name": "Sonarr"},
			map[string]interface{}{"appId": "radarr"},
			map[string]interface{}{"appId": "lidarr", "name": "  "},
			map[string]interface{}{"appId": "prowlarr", "name": "Prow\x1b[31mlarr"},
			map[string]interface{}{},
			"not an entry",
		},
	}
	got := appRemoveConnectionsLeft("sabnzbd", result)
	want := []string{
		"Sonarr may still list sabnzbd: remove it in Sonarr's settings.",
		"radarr may still list sabnzbd: remove it in radarr's settings.",
		"lidarr may still list sabnzbd: remove it in lidarr's settings.",
		"Prowlarr may still list sabnzbd: remove it in Prowlarr's settings.",
		"A connected app may still list sabnzbd: remove it in that app's settings.",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("lines =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestAppRemoveConnectionsLeftOlderControlPanel(t *testing.T) {
	// Before YE-199 the uninstall sent neither warnings nor connectionsLeft; a malformed field prints nothing either.
	for _, result := range []map[string]interface{}{
		{"success": true},
		{"success": true, "connectionsLeft": nil},
		{"success": true, "connectionsLeft": "sonarr"},
		{"success": true, "connectionsLeft": []interface{}{}},
	} {
		if got := appRemoveConnectionsLeft("sabnzbd", result); len(got) != 0 {
			t.Fatalf("result %v printed %q", result, got)
		}
	}
}

func TestAppRemoveConnectionsLeftIsCapped(t *testing.T) {
	var list []interface{}
	for i := 0; i < 30; i++ {
		list = append(list, map[string]interface{}{"appId": "app-" + string(rune('a'+i%26)) + string(rune('a'+i/26))})
	}
	if got := appRemoveConnectionsLeft("sabnzbd", map[string]interface{}{"success": true, "connectionsLeft": list}); len(got) != appRemoveConnectionsLeftMax {
		t.Fatalf("printed %d lines, want %d", len(got), appRemoveConnectionsLeftMax)
	}
}
