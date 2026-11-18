package controlapi

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A refusal keeps its raw error text and its JSON fields stay readable; the CLI token and the CSRF placeholder are sent.
func TestHTTPErrorFieldsAndHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-CLI-Token") != "token" || r.Header.Get("X-CSRF-Token") != "cli" {
			t.Errorf("headers: %v", r.Header)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"appId":"notes"}` {
			t.Errorf("body: %s", body)
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"Notes needs YouEye 0.7.0.","code":"requires-newer-youeye","needsYouEye":"0.7.0"}`))
	}))
	defer server.Close()

	_, err := NewClientAt(server.URL+"/", "token").Post("/api/market/install", map[string]string{"appId": "notes"})
	var answer *HTTPError
	if !errors.As(err, &answer) || answer.StatusCode != http.StatusConflict {
		t.Fatalf("error: %#v", err)
	}
	if answer.Field("code") != "requires-newer-youeye" || answer.Field("needsYouEye") != "0.7.0" || answer.Field("missing") != "" {
		t.Fatalf("fields: %q %q", answer.Field("code"), answer.Field("needsYouEye"))
	}
	if err.Error() != `control panel returned 409: {"error":"Notes needs YouEye 0.7.0.","code":"requires-newer-youeye","needsYouEye":"0.7.0"}` {
		t.Fatalf("error text changed: %s", err)
	}
	if (&HTTPError{StatusCode: 500, Body: []byte("not json")}).Field("error") != "" {
		t.Fatal("a body that is not JSON has no fields")
	}
}
