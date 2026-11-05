package cmd

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	deploymentBaseURL      = "http://127.0.0.1:3000"
	deploymentPollInterval = 2 * time.Second
	deploymentMaxWait      = 35 * time.Minute
)

var errDeploymentJobNotFound = errors.New("deployment job not found")

type deploymentJobFailure struct {
	Step    int    `json:"step"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

type deploymentJobState struct {
	ID        string                `json:"id"`
	Kind      string                `json:"kind"`
	Status    string                `json:"status"`
	Failure   *deploymentJobFailure `json:"failure,omitempty"`
	UpdatedAt string                `json:"updatedAt"`
}

type deploymentJobClient struct {
	baseURL      string
	secret       string
	httpClient   *http.Client
	pollInterval time.Duration
	maxWait      time.Duration
	logf         func(string, ...interface{})
}

func newDeploymentJobClient(baseURL, secret string) *deploymentJobClient {
	return &deploymentJobClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		secret:  secret,
		httpClient: &http.Client{Transport: &http.Transport{
			ResponseHeaderTimeout: 2 * time.Minute,
		}},
		pollInterval: deploymentPollInterval,
		maxWait:      deploymentMaxWait,
		logf:         func(format string, args ...interface{}) { fmt.Printf(format, args...) },
	}
}

func newInfrastructureDeploymentID(kind string) (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate deployment identity: %w", err)
	}
	return kind + "-" + hex.EncodeToString(random), nil
}

func (c *deploymentJobClient) endpoint(kind string) string {
	if kind == "reconcile" {
		return c.baseURL + "/api/deploy/infrastructure/reconcile"
	}
	return c.baseURL + "/api/deploy/infrastructure"
}

func (c *deploymentJobClient) startAndRead(ctx context.Context, kind, id, hostIP string) error {
	payload, err := json.Marshal(map[string]string{
		"host_ip":       hostIP,
		"deployment_id": id,
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(kind), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("X-Deploy-Secret", c.secret)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("open deployment progress stream: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("Control Panel returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event deploymentEvent
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			continue
		}
		printDeploymentEvent(event)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("progress stream ended unexpectedly: %w", err)
	}
	return nil
}

func printDeploymentEvent(event deploymentEvent) {
	stage, detail, percent := "", "", 0
	switch event.Step {
	case 1:
		stage, detail, percent = "database", "Preparing the platform database", 62
	case 2:
		stage, detail, percent = "web_gateway", "Preparing the Web gateway", 70
	case 3:
		stage, detail, percent = "network_shield", "Preparing the Network shield", 78
	case 4:
		stage, detail, percent = "ui", "Installing the YouEye UI", 86
	}
	if stage != "" {
		emitFirstDeployProgress(stage, detail, percent)
	}
	icon := "⏳"
	switch event.Status {
	case "success":
		icon = "✓"
	case "error":
		icon = "✗"
	case "skipped":
		icon = "→"
	}
	fmt.Printf("  %s [%d/%d] %s\n", icon, event.Step, event.TotalSteps, event.Message)
	if event.Detail != "" && event.Status == "error" {
		fmt.Printf("    Detail: %s\n", event.Detail)
	}
}

func (c *deploymentJobClient) get(ctx context.Context, id string) (deploymentJobState, error) {
	jobURL := c.baseURL + "/api/deploy/infrastructure/jobs/" + url.PathEscape(id)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, jobURL, nil)
	if err != nil {
		return deploymentJobState{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Deploy-Secret", c.secret)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return deploymentJobState{}, fmt.Errorf("query durable deployment state: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return deploymentJobState{}, errDeploymentJobNotFound
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return deploymentJobState{}, fmt.Errorf("deployment state returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var state deploymentJobState
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&state); err != nil {
		return deploymentJobState{}, fmt.Errorf("decode durable deployment state: %w", err)
	}
	return state, nil
}

func deploymentFailureError(state deploymentJobState) error {
	if state.Failure == nil {
		return fmt.Errorf("%s job %s failed without diagnostic state", state.Kind, state.ID)
	}
	if state.Failure.Detail == "" {
		return fmt.Errorf("%s job %s failed at step %d: %s", state.Kind, state.ID, state.Failure.Step, state.Failure.Message)
	}
	return fmt.Errorf("%s job %s failed at step %d: %s (%s)", state.Kind, state.ID, state.Failure.Step, state.Failure.Message, state.Failure.Detail)
}

func (c *deploymentJobClient) waitForTerminal(ctx context.Context, kind, id, hostIP string, allowReconcile bool) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		state, err := c.get(ctx, id)
		if err != nil {
			if errors.Is(err, errDeploymentJobNotFound) {
				return err
			}
			c.logf("  Progress state query failed; retrying: %v\n", err)
		} else {
			switch state.Status {
			case "succeeded":
				c.logf("  ✓ Durable %s job %s succeeded\n", kind, id)
				return nil
			case "failed":
				return deploymentFailureError(state)
			case "indeterminate":
				if !allowReconcile {
					return fmt.Errorf("%s job %s became indeterminate; operator reconciliation is required", kind, id)
				}
				reconcileID, err := newInfrastructureDeploymentID("reconcile")
				if err != nil {
					return err
				}
				c.logf("  Progress owner was lost; reconciling infrastructure as %s\n", reconcileID)
				return c.executeWithIDContext(ctx, "reconcile", reconcileID, hostIP, false)
			case "running":
				// The mutation is alive independently of the progress connection.
			default:
				return fmt.Errorf("%s job %s returned unknown status %q", kind, id, state.Status)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.pollInterval):
		}
	}
}

func (c *deploymentJobClient) executeWithIDContext(ctx context.Context, kind, id, hostIP string, allowReconcile bool) error {
	var streamErr error
	for attempt := 1; attempt <= 3; attempt++ {
		streamErr = c.startAndRead(ctx, kind, id, hostIP)
		if streamErr != nil {
			c.logf("  Progress channel unavailable for job %s: %v\n", id, streamErr)
		}

		err := c.waitForTerminal(ctx, kind, id, hostIP, allowReconcile)
		if !errors.Is(err, errDeploymentJobNotFound) {
			return err
		}
		if attempt < 3 {
			c.logf("  Deployment job was not recorded; retrying the idempotent start (%d/3)\n", attempt+1)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.pollInterval):
			}
		}
	}
	if streamErr != nil {
		return fmt.Errorf("Control Panel did not record %s job %s after three idempotent starts: %w", kind, id, streamErr)
	}
	return fmt.Errorf("Control Panel did not record %s job %s after three idempotent starts", kind, id)
}

func (c *deploymentJobClient) executeWithID(kind, id, hostIP string, allowReconcile bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), c.maxWait)
	defer cancel()
	err := c.executeWithIDContext(ctx, kind, id, hostIP, allowReconcile)
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("timed out after %s executing durable %s job %s", c.maxWait, kind, id)
	}
	return err
}

func (c *deploymentJobClient) execute(kind, hostIP string) error {
	id, err := newInfrastructureDeploymentID(kind)
	if err != nil {
		return err
	}
	return c.executeWithID(kind, id, hostIP, kind == "deploy")
}
