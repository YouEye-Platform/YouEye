package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIndependentCopyPiholeRemovesInheritedSessionsAndLogsOut(t *testing.T) {
	for _, staleReadback := range []bool{false, true} {
		t.Run(map[bool]string{false: "cleared", true: "retained session refuses completion"}[staleReadback], func(t *testing.T) {
			inherited, loggedOut := true, false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.RawQuery != "" {
					t.Error("credential appeared in URL")
				}
				if r.Method == "POST" && r.URL.Path == "/api/auth" {
					var body map[string]string
					if json.NewDecoder(r.Body).Decode(&body) != nil || body["password"] != "synthetic-new-password" {
						t.Error("new password not used")
					}
					_, _ = w.Write([]byte(`{"session":{"valid":true,"sid":"synthetic-new-session"}}`))
					return
				}
				if r.Header.Get("X-FTL-SID") != "synthetic-new-session" {
					t.Error("missing new authentication")
				}
				switch r.Method + " " + r.URL.Path {
				case "GET /api/auth/sessions":
					items := []any{map[string]any{"id": 2, "current_session": true}}
					if inherited || staleReadback {
						items = append(items, map[string]any{"id": 0, "current_session": false})
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"sessions": items})
				case "DELETE /api/auth/session/0":
					inherited = false
					w.WriteHeader(204)
				case "DELETE /api/auth":
					loggedOut = true
					w.WriteHeader(204)
				default:
					t.Error("unexpected request", r.Method, r.URL.Path)
					w.WriteHeader(500)
				}
			}))
			defer server.Close()
			err := clearCopiedPiholeSessions(context.Background(), server.Client(), server.URL, "synthetic-new-password")
			if staleReadback {
				if err == nil || loggedOut {
					t.Fatal("retained old session was accepted")
				}
			} else if err != nil || inherited || !loggedOut {
				t.Fatal("session cleanup failed", err)
			}
		})
	}
}
