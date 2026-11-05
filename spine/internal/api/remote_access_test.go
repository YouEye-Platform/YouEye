package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/remoteaccess"
)

type fakeRemoteAccess struct {
	keys        []remoteaccess.Key
	added       string
	deleted     string
	confirmLast bool
	deleteError error
}

func (f *fakeRemoteAccess) List() ([]remoteaccess.Key, error) { return f.keys, nil }
func (f *fakeRemoteAccess) Add(line, source string) (remoteaccess.Key, error) {
	f.added = line + ":" + source
	return remoteaccess.Key{ID: "0123456789abcdef01234567", Fingerprint: "SHA256:test"}, nil
}
func (f *fakeRemoteAccess) Delete(id string, confirmLast bool) (remoteaccess.Key, error) {
	f.deleted, f.confirmLast = id, confirmLast
	return remoteaccess.Key{ID: id}, f.deleteError
}

func remoteAccessTestServer() (*Server, *fakeRemoteAccess) {
	server := NewServer("test", config.Default())
	fake := &fakeRemoteAccess{keys: []remoteaccess.Key{{ID: "0123456789abcdef01234567", Fingerprint: "SHA256:test"}}}
	server.remoteAccess = fake
	server.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		manifest := &appliance.Manifest{ImageVersion: "1.0.0"}
		return appliance.RuntimeStatus{Kind: appliance.RuntimeApplianceImage, ManifestValid: true}, manifest, nil
	}
	return server, fake
}

func TestRemoteAccessAPIListsAddsAndDeletesKeys(t *testing.T) {
	server, fake := remoteAccessTestServer()
	fake.keys[0].PublicKey = "ssh-ed25519 SHOULD-NOT-LEAVE-SPINE"

	request := httptest.NewRequest(http.MethodGet, "/api/appliance/remote-access/keys", nil)
	response := httptest.NewRecorder()
	server.handleRemoteAccessKeys(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"root_password_locked":true`) {
		t.Fatalf("GET response = %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "public_key") || strings.Contains(response.Body.String(), "SHOULD-NOT-LEAVE-SPINE") {
		t.Fatalf("GET exposed stored public-key material: %s", response.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, "/api/appliance/remote-access/keys", strings.NewReader(`{"public_key":"ssh-ed25519 AAAATEST operator"}`))
	response = httptest.NewRecorder()
	server.handleRemoteAccessKeys(response, request)
	if response.Code != http.StatusCreated || fake.added != "ssh-ed25519 AAAATEST operator:settings" {
		t.Fatalf("POST response = %d %s, added=%q", response.Code, response.Body.String(), fake.added)
	}

	id := "0123456789abcdef01234567"
	request = httptest.NewRequest(http.MethodDelete, "/api/appliance/remote-access/keys/"+id, strings.NewReader(`{"confirm_last_key":true}`))
	response = httptest.NewRecorder()
	server.handleRemoteAccessKey(response, request)
	if response.Code != http.StatusOK || fake.deleted != id || !fake.confirmLast {
		t.Fatalf("DELETE response = %d %s, fake=%+v", response.Code, response.Body.String(), fake)
	}
}

func TestRemoteAccessAPIFailsClosed(t *testing.T) {
	server, fake := remoteAccessTestServer()
	tests := []struct {
		name   string
		method string
		path   string
		body   string
		code   int
	}{
		{"unknown add field", http.MethodPost, "/api/appliance/remote-access/keys", `{"public_key":"x","extra":true}`, http.StatusBadRequest},
		{"missing ID", http.MethodDelete, "/api/appliance/remote-access/keys/short", `{}`, http.StatusBadRequest},
		{"wrong method", http.MethodPut, "/api/appliance/remote-access/keys", `{}`, http.StatusMethodNotAllowed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			response := httptest.NewRecorder()
			if strings.HasSuffix(test.path, "/keys") {
				server.handleRemoteAccessKeys(response, request)
			} else {
				server.handleRemoteAccessKey(response, request)
			}
			if response.Code != test.code {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
	}
	fake.deleteError = errors.New("deleting the final SSH key requires explicit confirmation")
	request := httptest.NewRequest(http.MethodDelete, "/api/appliance/remote-access/keys/0123456789abcdef01234567", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	server.handleRemoteAccessKey(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("final key response = %d %s", response.Code, response.Body.String())
	}
}

func TestRemoteAccessAPIRequiresAppliance(t *testing.T) {
	server, _ := remoteAccessTestServer()
	server.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		return appliance.RuntimeStatus{Kind: appliance.RuntimeMutableHost}, nil, nil
	}
	request := httptest.NewRequest(http.MethodGet, "/api/appliance/remote-access/keys", nil)
	response := httptest.NewRecorder()
	server.handleRemoteAccessKeys(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "appliance_required") {
		t.Fatalf("mutable response = %d %s", response.Code, response.Body.String())
	}
}
