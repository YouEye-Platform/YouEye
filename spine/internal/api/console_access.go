package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/youeye-platform/YouEye/spine/internal/consoleaccess"
)

// consoleAccessService is consoleaccess.Manager; tests replace it.
type consoleAccessService interface {
	Status() (consoleaccess.Status, error)
	Change(func(*consoleaccess.Record, map[string]bool) error) error
	UseResetCode(code string) error
}

type consoleSyncRequest struct {
	Admins []consoleaccess.Admin `json:"admins"`
}

type consolePasswordRequest struct {
	UserID   string `json:"user_id"`
	Password string `json:"password"`
}

// RootPassword: absent = unchanged, "" = remove (root locked), else set.
type consoleSettingsRequest struct {
	RootPassword *string `json:"root_password"`
	PasswordSSH  *bool   `json:"password_ssh"`
}

type consoleResetRequest struct {
	Code string `json:"code"`
}

// Console access (admins' host accounts). The Control Panel is the only
// caller: it syncs the admin set after every identity change, and sends an
// admin's password once when it is set.
//
//	GET  /api/console                      status (never a hash)
//	POST /api/console/accounts/sync        {admins:[{user_id,username}]}: exactly these are admins
//	PUT  /api/console/accounts/password    {user_id,password} ("" clears it and locks the account)
//	PUT  /api/console/settings             {root_password?, password_ssh?}
//	POST /api/console/owner-reset          {code}: consume the code the console shows
func (s *Server) handleConsoleAccess(w http.ResponseWriter, r *http.Request) {
	if !s.requireSealedAppliance(w) {
		return
	}
	route := r.Method + " " + r.URL.Path
	decode := func(value any) bool {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
		if err := decodeOne(decoder, value); err != nil {
			errorResponse(w, "invalid console access request", http.StatusBadRequest)
			return false
		}
		return true
	}
	var err error
	switch route {
	case "GET /api/console":
	case "POST /api/console/accounts/sync":
		var request consoleSyncRequest
		if !decode(&request) {
			return
		}
		err = s.consoleAccess.Change(func(record *consoleaccess.Record, taken map[string]bool) error {
			return record.Sync(request.Admins, taken)
		})
	case "PUT /api/console/accounts/password":
		var request consolePasswordRequest
		if !decode(&request) {
			return
		}
		err = s.consoleAccess.Change(func(record *consoleaccess.Record, _ map[string]bool) error {
			if request.Password == "" {
				// The CP couldn't deliver a new password: the old one must stop working.
				record.ClearPassword(request.UserID)
				return nil
			}
			return record.SetPassword(request.UserID, request.Password)
		})
	case "PUT /api/console/settings":
		var request consoleSettingsRequest
		if !decode(&request) {
			return
		}
		err = s.consoleAccess.Change(func(record *consoleaccess.Record, _ map[string]bool) error {
			if request.RootPassword != nil {
				record.RootPasswordHash = ""
				if *request.RootPassword != "" {
					hash, err := consoleaccess.HashPassword(*request.RootPassword)
					if err != nil {
						return err
					}
					record.RootPasswordHash = hash
				}
			}
			if request.PasswordSSH != nil {
				record.PasswordSSH = *request.PasswordSSH
			}
			return nil
		})
	case "POST /api/console/owner-reset":
		var request consoleResetRequest
		if !decode(&request) {
			return
		}
		if err := s.consoleAccess.UseResetCode(request.Code); err != nil {
			errorResponse(w, err.Error(), http.StatusForbidden)
			return
		}
		jsonResponse(w, map[string]bool{"valid": true})
		return
	default:
		errorResponse(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		status := http.StatusConflict
		if errors.Is(err, consoleaccess.ErrResetCode) {
			status = http.StatusForbidden
		}
		errorResponse(w, err.Error(), status)
		return
	}
	status, err := s.consoleAccess.Status()
	if err != nil {
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(w, status)
}
