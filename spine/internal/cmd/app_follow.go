package cmd

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/controlapi"
	"github.com/youeye-platform/YouEye/spine/internal/output"
)

// A dropped progress stream is not a failed operation: the Control Panel keeps updating (or installing) the app and
// records the outcome. These bound how the CLI follows that record instead (variables so tests can shorten them).
var (
	followPollInterval = 3 * time.Second
	// followLimit bounds the whole wait; an app update can take many minutes (image pulls, migrations).
	followLimit = 30 * time.Minute
	// followStartLimit is how long an install may take to be recorded before the CLI concludes there is none.
	followStartLimit = 3 * time.Minute
	followSleep      = time.Sleep
)

const lostProgressNotice = "Lost the live progress; following the update..."

// The Control Panel's own words for an update's outcome (lib/market/update-http.ts), for an update whose returned
// result the Control Panel no longer has (it restarted): the CLI reports the operation record as the stream would.
const (
	updateCompleteText   = "Update complete"
	updateRolledBackText = "The update failed and was rolled back: the app runs its previous version. The cause is in the " +
		"Control Panel journal."
	updateRecoveryRequiredText = "The update failed and the app could not be brought back: it stays in maintenance and its " +
		"recovery points are kept. Retry recovery (youeye app recover %s); the cause is in the Control Panel journal."
)

// appUpdateOperation is the projection of the status's operation record that the CLI reads.
type appUpdateOperation struct {
	ID               string
	Committed        bool
	RolledBack       bool
	RecoveryRequired bool
	Pending          bool
}

// appUpdateResult is what the app's last update said as it returned, in the stream's words.
type appUpdateResult struct {
	OperationID string // empty when the update ended before an operation (already up to date, or refused)
	Success     bool
	Message     string
	At          string
}

// appUpdateStatus is the CLI's projection of /api/market/update/status.
type appUpdateStatus struct {
	Operation *appUpdateOperation
	// Result is the last update's returned result in this Control Panel run (nil after a restart).
	Result *appUpdateResult
	// Results are the app's last few returned results, newest last: a later update must not hide this one's.
	Results []*appUpdateResult
	// Running: an update of the app is on its way to a result in this Control Panel.
	Running bool
	// Market: the app is updated by the Market updater, which records the above. Built-in apps (Pointer, Caddy,
	// Pi-hole, Postgres and the core components) have their own updaters and records.
	Market bool
}

// readAppUpdateStatus reads the app's update status.
func readAppUpdateStatus(appID string) (*appUpdateStatus, error) {
	raw, err := controlClient.Get("/api/market/update/status?appId=" + url.QueryEscape(appID))
	if err != nil {
		return nil, err
	}
	status := &appUpdateStatus{}
	status.Running, _ = raw["running"].(bool)
	status.Market, _ = raw["market"].(bool)
	if op, _ := raw["operation"].(map[string]interface{}); op != nil {
		operation := &appUpdateOperation{ID: str(op, "id")}
		operation.Committed, _ = op["committed"].(bool)
		operation.RolledBack, _ = op["rolledBack"].(bool)
		operation.RecoveryRequired, _ = op["recoveryRequired"].(bool)
		operation.Pending, _ = op["pending"].(bool)
		status.Operation = operation
	}
	parse := func(res map[string]interface{}) *appUpdateResult {
		result := &appUpdateResult{OperationID: str(res, "operationId"), Message: str(res, "message"), At: str(res, "at")}
		result.Success, _ = res["success"].(bool)
		return result
	}
	if res, _ := raw["result"].(map[string]interface{}); res != nil {
		status.Result = parse(res)
	}
	if list, _ := raw["results"].([]interface{}); list != nil {
		for _, item := range list {
			if res, _ := item.(map[string]interface{}); res != nil {
				status.Results = append(status.Results, parse(res))
			}
		}
	}
	return status, nil
}

// updateStreamWatch prints a streamed update's events and remembers its terminal stage: completed, failed or pending
// (the update returned with its operation unfinished).
type updateStreamWatch struct{ terminal, operationID string }

func (w *updateStreamWatch) handle(event controlapi.SSEEvent) {
	terminalSSE(event)
	if event.OperationID != "" && w.operationID == "" {
		w.operationID = event.OperationID
	}
	stage := strings.ToLower(strings.TrimSpace(event.Status))
	if stage == "" {
		stage = strings.ToLower(strings.TrimSpace(event.Stage))
	}
	switch stage {
	case "completed", "complete", "success":
		w.terminal = "completed"
	case "failed", "error":
		w.terminal = "failed"
	case "pending":
		w.terminal = "pending"
	}
}

// runAppUpdate updates one app over the Control Panel's progress stream. When the stream of a Market app's update
// breaks off before the update's outcome (a transport error, or a stream that ends without one), the update keeps
// running in the Control Panel: the CLI follows its status and reports the outcome from there. A built-in app's
// update is not recorded there, so its lost stream is reported as it is. Success is the only nil result.
func runAppUpdate(name string, payload interface{}) error {
	// The status before this update, so the follow never reports an older update as this one's outcome.
	prior, priorErr := readAppUpdateStatus(name)
	if priorErr != nil {
		prior = nil
	}
	watch := &updateStreamWatch{}
	err := controlClient.PostSSE("/api/apps/"+name+"/update", payload, watch.handle)
	switch watch.terminal {
	case "completed":
		return nil
	case "failed":
		return controlapi.ErrSSETerminalFailure
	case "pending":
		// The Control Panel's message (printed) says what is unfinished and how to recover.
		return &ExitError{Code: 1}
	}
	var lost *controlapi.StreamLostError
	if err != nil && !errors.As(err, &lost) {
		return newerYouEyeRefusal(err)
	}
	if err == nil {
		err = errors.New("the Control Panel's progress stream ended without the update's outcome")
	}
	if prior != nil && !prior.Market {
		return unfollowedUpdate(name, err)
	}
	output.Warn(lostProgressNotice)
	return followAppUpdate(name, prior, err, watch.operationID)
}

// unfollowedUpdate reports a lost stream of an update the Control Panel does not record (a built-in app's).
func unfollowedUpdate(name string, streamErr error) error {
	shown := terminalText(name, false)
	return fmt.Errorf("%s; the update may still be running: check the app with: youeye app info %s",
		cleanServerError(streamErr).Error(), shown)
}

// followAppUpdate polls the app's update status until this update's returned result is there, and reports it in
// the stream's words. An update is this one when its operation's id differs from the one before the request, or
// once it was seen pending; an update that ended without an operation is this one when its result is newer than
// the one before. When the Control Panel lost the result (it restarted), the operation record is reported instead.
func followAppUpdate(name string, prior *appUpdateStatus, streamErr error, known string) error {
	priorID, priorAt := "", ""
	if prior != nil && prior.Operation != nil {
		priorID = prior.Operation.ID
	}
	if prior != nil && prior.Result != nil {
		priorAt = prior.Result.At
	}
	started := time.Now()
	shown := terminalText(name, false)
	// The stream names this update's operation once it exists; before that, the follower finds it.
	ours := known
	var lastErr error
	readOnce := false
	for {
		status, err := readAppUpdateStatus(name)
		lastErr = err
		if err == nil {
			readOnce = true
			if !status.Market {
				return unfollowedUpdate(name, streamErr)
			}
			operation, result := status.Operation, status.Result
			// This update's operation is the first new one seen; once known it never changes, so a later update of the
			// app cannot be taken for it.
			if operation != nil && ours == "" && (operation.Pending || (prior != nil && operation.ID != priorID)) {
				ours = operation.ID
			}
			// This update's own result, even when a later update of the app returned after it.
			if ours != "" {
				for i := len(status.Results) - 1; i >= 0; i-- {
					if status.Results[i].OperationID == ours {
						result = status.Results[i]
						break
					}
				}
			}
			switch {
			case result != nil && ours != "" && result.OperationID == ours:
				return reportAppUpdateResult(name, result)
			case status.Running:
				// Still on its way to a result: a commit is followed by cleanup and access reconciliation, which can
				// still fail, and an update may wait for another operation first.
			case ours == "" && result != nil && (prior == nil || result.At != priorAt):
				return reportAppUpdateResult(name, result)
			case ours == "":
				return fmt.Errorf("the Control Panel recorded no update of %s (it may have restarted); check the app "+
					"with: youeye app info %s", shown, shown)
			case operation != nil && operation.ID == ours && !operation.Pending:
				output.Warn("The Control Panel did not record the update's final result (it restarted); its operation " +
					"record says:")
				return reportAppUpdateOperation(shown, operation)
			case operation != nil && operation.ID != ours && !operation.Pending:
				// Another update of the app followed this one, and this one's result was lost with a restart.
				return fmt.Errorf("the Control Panel did not record the final result of this update of %s (it restarted, "+
					"and the app has been updated since); check the app with: youeye app info %s", shown, shown)
			}
			// Otherwise the operation is pending in a Control Panel that restarted: its recovery may still finish it.
		}
		if time.Since(started) >= followLimit && !readOnce {
			return fmt.Errorf("could not read the update status of %s for %s (%v); check it later with: youeye app info %s",
				shown, followLimit, cleanServerError(lastErr), shown)
		}
		if time.Since(started) >= followLimit {
			return fmt.Errorf("the update of %s is still running after %s; check it later with: youeye app info %s "+
				"(or in the Control Panel's Updates). If it stays pending, retry recovery with: youeye app recover %s",
				shown, followLimit, shown, shown)
		}
		followSleep(followPollInterval)
	}
}

// reportAppUpdateResult prints an update's returned result as its stream said it: exit 0 only on success.
func reportAppUpdateResult(name string, result *appUpdateResult) error {
	message := terminalText(strings.ReplaceAll(result.Message, "<app>", name), true)
	if result.Success {
		if message == "" {
			message = updateCompleteText
		}
		output.Success(message)
		return nil
	}
	if message == "" {
		message = "The update failed; the cause is in the Control Panel journal."
	}
	output.Error(message)
	return &ExitError{Code: 1}
}

// reportAppUpdateOperation reports a finished operation from its record, as the stream would have.
func reportAppUpdateOperation(shown string, operation *appUpdateOperation) error {
	switch {
	case operation.RecoveryRequired:
		output.Error(fmt.Sprintf(updateRecoveryRequiredText, shown))
		return &ExitError{Code: 1}
	case operation.Committed:
		output.Success(updateCompleteText)
		return nil
	case operation.RolledBack:
		output.Error(updateRolledBackText)
		return &ExitError{Code: 1}
	default:
		output.Error(fmt.Sprintf(updateRecoveryRequiredText, shown))
		return &ExitError{Code: 1}
	}
}

// runAppInstall installs one Market app over the Control Panel's progress stream. The Control Panel records an
// install before it answers (lib/market/install-tracker.ts), so a stream that breaks off is followed through
// /api/market/install-status until the install is done.
func runAppInstall(appID string, body map[string]interface{}) error {
	err := controlClient.PostSSE("/api/market/install", body, terminalSSE)
	var lost *controlapi.StreamLostError
	if !errors.As(err, &lost) {
		return newerYouEyeRefusal(err)
	}
	output.Warn("Lost the live progress; following the install...")
	return followAppInstall(appID)
}

// followAppInstall polls the app's tracked install until it is done and reports its outcome.
func followAppInstall(appID string) error {
	started := time.Now()
	shown := terminalText(appID, false)
	recorded := false
	for {
		status, err := controlClient.Get("/api/market/install-status?app=" + url.QueryEscape(appID))
		if err == nil {
			recorded = true
			if done, _ := status["done"].(bool); done {
				if message := terminalText(str(status, "error"), true); message != "" {
					output.Error(message)
					return &ExitError{Code: 1}
				}
				if cancelled, _ := status["cancelled"].(bool); cancelled {
					output.Error("The install of " + shown + " was cancelled")
					return &ExitError{Code: 1}
				}
				// The stream's own last words (lib/market/engine.ts), which scripts look for.
				name := terminalText(str(status, "appName"), false)
				if name == "" {
					name = shown
				}
				output.Success(name + " installed successfully!")
				return nil
			}
		}
		elapsed := time.Since(started)
		if !recorded && elapsed >= followStartLimit {
			return fmt.Errorf("the Control Panel shows no install of %s; check the app with: youeye app info %s", shown, shown)
		}
		if elapsed >= followLimit {
			return fmt.Errorf("the install of %s is still running after %s; check it later with: youeye app info %s",
				shown, followLimit, shown)
		}
		followSleep(followPollInterval)
	}
}
