package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Called while the exact destination remains quarantined. Password writes go
// through Pi-hole's own CLI. API session deletion is explicit: a container
// restart alone can restore sessions from Pi-hole's database.
func prepareCopyPihole(ctx context.Context) error {
	password, err := readStoredPiholePassword()
	if err != nil {
		return fmt.Errorf("prepared Pi-hole password unavailable")
	}
	if _, err = runWithTimeout(30*time.Second, "incus", "--force-local", "--project", "default", "exec", "youeye-pihole", "--", "pihole", "setpassword", password); err != nil {
		return fmt.Errorf("Pi-hole credential preparation requires reconciliation")
	}
	if err = waitForPiholeHealthyLoopback(password, 30*time.Second); err != nil {
		return fmt.Errorf("prepared Pi-hole credential is not usable")
	}
	ip, err := containerIPv4("youeye-pihole")
	if err != nil {
		return fmt.Errorf("prepared Pi-hole endpoint unavailable")
	}
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if err = clearCopiedPiholeSessions(ctx, client, "http://"+ip+":80", password); err != nil {
		return err
	}
	// A graceful stop persists the cleared session set. The exact container
	// identity is checked by the enclosing native copy startup coordinator.
	if err = stopContainer("youeye-pihole", 45*time.Second); err != nil {
		return fmt.Errorf("Pi-hole session persistence requires reconciliation")
	}
	if err = ensureContainerRunning("youeye-pihole", 60*time.Second); err != nil {
		return err
	}
	return waitForPiholeHealthyLoopback(password, 30*time.Second)
}

func clearCopiedPiholeSessions(ctx context.Context, client *http.Client, base, password string) error {
	sid := ""
	call := func(method, path string, body []byte, result any) error {
		req, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(body))
		if err != nil {
			return fmt.Errorf("invalid local Pi-hole request")
		}
		req.Header.Set("Content-Type", "application/json")
		if sid != "" {
			req.Header.Set("X-FTL-SID", sid)
		}
		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("Pi-hole copy session reconciliation unavailable")
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
			return fmt.Errorf("Pi-hole copy session reconciliation rejected")
		}
		if result != nil {
			if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(result) != nil {
				return fmt.Errorf("invalid Pi-hole copy session observation")
			}
		}
		return nil
	}
	var auth struct {
		Session struct {
			Valid bool   `json:"valid"`
			SID   string `json:"sid"`
		} `json:"session"`
	}
	body, _ := json.Marshal(map[string]string{"password": password})
	if err := call("POST", "/api/auth", body, &auth); err != nil {
		return err
	}
	if !auth.Session.Valid || auth.Session.SID == "" {
		return fmt.Errorf("prepared Pi-hole credential rejected")
	}
	sid = auth.Session.SID
	type session struct {
		ID      *int `json:"id"`
		Current bool `json:"current_session"`
	}
	var inventory struct {
		Sessions *[]session `json:"sessions"`
	}
	if err := call("GET", "/api/auth/sessions", nil, &inventory); err != nil {
		return err
	}
	if inventory.Sessions == nil {
		return fmt.Errorf("Pi-hole session inventory absent")
	}
	current := 0
	seen := map[int]bool{}
	for _, item := range *inventory.Sessions {
		if item.ID == nil || *item.ID < 0 || seen[*item.ID] {
			return fmt.Errorf("Pi-hole session inventory ambiguous")
		}
		seen[*item.ID] = true
		if item.Current {
			current++
			continue
		}
		if err := call("DELETE", "/api/auth/session/"+strconv.Itoa(*item.ID), nil, nil); err != nil {
			return err
		}
	}
	if current != 1 {
		return fmt.Errorf("Pi-hole current session not observed")
	}
	inventory.Sessions = nil
	if err := call("GET", "/api/auth/sessions", nil, &inventory); err != nil {
		return err
	}
	if inventory.Sessions == nil || len(*inventory.Sessions) != 1 || !(*inventory.Sessions)[0].Current {
		return fmt.Errorf("copied Pi-hole sessions remain")
	}
	return call("DELETE", "/api/auth", nil, nil)
}
