package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/config"
	"github.com/youeye-platform/YouEye/spine/internal/consoleaccess"
)

type fakeConsoleAccess struct {
	record consoleaccess.Record
	code   string
}

func (f *fakeConsoleAccess) Status() (consoleaccess.Status, error) {
	status := consoleaccess.Status{Accounts: []consoleaccess.AccountStatus{}, RootPasswordSet: f.record.RootPasswordHash != "", PasswordSSH: f.record.PasswordSSH}
	for _, a := range f.record.Accounts {
		status.Accounts = append(status.Accounts, consoleaccess.AccountStatus{UserID: a.UserID, Username: a.Username, Admin: a.Admin, Locked: a.Locked, HasPassword: a.PasswordHash != ""})
	}
	return status, nil
}
func (f *fakeConsoleAccess) Change(change func(*consoleaccess.Record, map[string]bool) error) error {
	next := f.record
	next.Accounts = append([]consoleaccess.Account(nil), f.record.Accounts...)
	if err := change(&next, map[string]bool{"root": true}); err != nil {
		return err
	}
	f.record = next
	return nil
}
func (f *fakeConsoleAccess) UseResetCode(code string) error {
	if code != f.code {
		return consoleaccess.ErrResetCode
	}
	return nil
}

func TestConsoleAccessAPI(t *testing.T) {
	server := NewServer("test", config.Default())
	fake := &fakeConsoleAccess{code: "ABCDE-FGHJK"}
	server.consoleAccess = fake
	server.runtimeDetect = func() (appliance.RuntimeStatus, *appliance.Manifest, error) {
		return appliance.RuntimeStatus{Kind: appliance.RuntimeApplianceImage, ManifestValid: true}, &appliance.Manifest{ImageVersion: "1.0.0"}, nil
	}
	call := func(method, path, body string) (int, consoleaccess.Status) {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		response := httptest.NewRecorder()
		server.handleConsoleAccess(response, request)
		var status consoleaccess.Status
		_ = json.Unmarshal(response.Body.Bytes(), &status)
		return response.Code, status
	}
	if code, status := call("POST", "/api/console/accounts/sync", `{"admins":[{"user_id":"u1","username":"anna"}]}`); code != http.StatusOK || len(status.Accounts) != 1 || !status.Accounts[0].Locked {
		t.Fatalf("sync: %d %+v", code, status)
	}
	if code, status := call("PUT", "/api/console/accounts/password", `{"user_id":"u1","password":"a long password"}`); code != http.StatusOK || status.Accounts[0].Locked || !status.Accounts[0].HasPassword {
		t.Fatalf("password: %d %+v", code, status)
	}
	if code, _ := call("PUT", "/api/console/accounts/password", `{"user_id":"nobody","password":"a long password"}`); code != http.StatusConflict {
		t.Fatalf("password for a non-admin: %d", code)
	}
	if code, status := call("PUT", "/api/console/settings", `{"root_password":"root password!","password_ssh":true}`); code != http.StatusOK || !status.RootPasswordSet || !status.PasswordSSH {
		t.Fatalf("settings: %d %+v", code, status)
	}
	if code, status := call("PUT", "/api/console/settings", `{"root_password":""}`); code != http.StatusOK || status.RootPasswordSet || !status.PasswordSSH {
		t.Fatalf("clear root: %d %+v", code, status)
	}
	if code, _ := call("POST", "/api/console/owner-reset", `{"code":"WRONG"}`); code != http.StatusForbidden {
		t.Fatalf("wrong code: %d", code)
	}
	if code, _ := call("POST", "/api/console/owner-reset", `{"code":"ABCDE-FGHJK"}`); code != http.StatusOK {
		t.Fatalf("right code: %d", code)
	}
	if code, _ := call("DELETE", "/api/console", ``); code != http.StatusNotFound {
		t.Fatalf("unknown route: %d", code)
	}
}
