package systemupdate

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCoreAuthenticatedHealthRequiresExactCompletedLiveDatabaseEvidence(t *testing.T) {
	marker := coreComponentMarker{Schema: "youeye.core-component.v1", Role: "cp", RequestID: "health-1", ManifestSHA256: strings.Repeat("a", 64), ArtifactSHA256: strings.Repeat("b", 64)}
	for _, fixture := range []string{"healthy", "no-database", "started", "foreign", "unauthorized", "redirect"} {
		t.Run(fixture, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "GET" || r.Header.Get("X-CLI-Token") != strings.Repeat("c", 64) || r.URL.Query().Get("health") != "1" {
					t.Error("wrong health request")
					w.WriteHeader(400)
					return
				}
				if fixture == "unauthorized" {
					w.WriteHeader(403)
					return
				}
				if fixture == "redirect" {
					w.Header().Set("Location", "/elsewhere")
					w.WriteHeader(302)
					return
				}
				result := coreSchemaObservation{coreComponentMarker: marker, Managed: true, State: "completed", DatabaseReady: true}
				if fixture == "no-database" {
					result.DatabaseReady = false
				}
				if fixture == "started" {
					result.State = "started"
				}
				if fixture == "foreign" {
					result.ArtifactSHA256 = strings.Repeat("d", 64)
				}
				_ = json.NewEncoder(w).Encode(result)
			}))
			defer server.Close()
			client := server.Client()
			client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			err := coreAuthenticatedHealthRequest(context.Background(), client, server.URL+"/?health=1", strings.Repeat("c", 64), marker)
			if (err == nil) != (fixture == "healthy") || calls != 1 {
				t.Fatal(err, calls)
			}
		})
	}
}
