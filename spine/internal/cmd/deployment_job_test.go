package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testDeploymentClient(server *httptest.Server) *deploymentJobClient {
	client := newDeploymentJobClient(server.URL, "unit-auth")
	client.pollInterval = time.Millisecond
	client.maxWait = time.Second
	client.logf = func(string, ...interface{}) {}
	return client
}

func writeJobState(t *testing.T, w http.ResponseWriter, state deploymentJobState) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(state); err != nil {
		t.Fatalf("encode state: %v", err)
	}
}

func TestDeploymentProgressEOFPollsRunningJobToSuccess(t *testing.T) {
	var polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/deploy/infrastructure":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"step\":2,\"totalSteps\":4,\"status\":\"running\",\"message\":\"Deploying Caddy\"}\n\n")
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/jobs/"):
			status := "running"
			if polls.Add(1) >= 2 {
				status = "succeeded"
			}
			writeJobState(t, w, deploymentJobState{ID: "deploy-early-eof", Kind: "deploy", Status: status})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := testDeploymentClient(server)
	if err := client.executeWithID("deploy", "deploy-early-eof", "192.0.2.20", true); err != nil {
		t.Fatalf("execute after early EOF: %v", err)
	}
	if polls.Load() < 2 {
		t.Fatalf("expected running job to be polled, got %d polls", polls.Load())
	}
}

func TestDeploymentDisconnectAfterServerCompletionUsesDurableSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "text/event-stream")
			// The response ends without a terminal SSE event, after server work is done.
		case r.Method == http.MethodGet:
			writeJobState(t, w, deploymentJobState{ID: "deploy-finished", Kind: "deploy", Status: "succeeded"})
		}
	}))
	defer server.Close()

	if err := testDeploymentClient(server).executeWithID("deploy", "deploy-finished", "192.0.2.21", true); err != nil {
		t.Fatalf("durable completion was not accepted: %v", err)
	}
}

func TestDeploymentGenuineFailureNamesStep(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.Header().Set("Content-Type", "text/event-stream")
			return
		}
		writeJobState(t, w, deploymentJobState{
			ID:     "deploy-failed",
			Kind:   "deploy",
			Status: "failed",
			Failure: &deploymentJobFailure{
				Step:    3,
				Message: "Pi-Hole deployment failed",
				Detail:  "DNS health check timed out",
			},
		})
	}))
	defer server.Close()

	err := testDeploymentClient(server).executeWithID("deploy", "deploy-failed", "192.0.2.22", true)
	if err == nil {
		t.Fatal("genuine deployment failure unexpectedly succeeded")
	}
	for _, want := range []string{"step 3", "Pi-Hole deployment failed", "DNS health check timed out"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
}

func TestIndeterminateDeploymentStartsReconciliation(t *testing.T) {
	var reconcilePosts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/deploy/infrastructure/reconcile":
			reconcilePosts.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
		case r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "text/event-stream")
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "reconcile-"):
			writeJobState(t, w, deploymentJobState{ID: "reconcile-job", Kind: "reconcile", Status: "succeeded"})
		case r.Method == http.MethodGet:
			writeJobState(t, w, deploymentJobState{ID: "deploy-orphaned", Kind: "deploy", Status: "indeterminate"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	if err := testDeploymentClient(server).executeWithID("deploy", "deploy-orphaned", "192.0.2.23", true); err != nil {
		t.Fatalf("reconciliation did not recover indeterminate deployment: %v", err)
	}
	if reconcilePosts.Load() != 1 {
		t.Fatalf("reconciliation posts = %d, want 1", reconcilePosts.Load())
	}
}

func TestDeploymentPOSTReusesStableIdentity(t *testing.T) {
	var bodies []string
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			body, _ := io.ReadAll(r.Body)
			bodies = append(bodies, string(body))
			w.Header().Set("Content-Type", "text/event-stream")
			return
		}
		writeJobState(t, w, deploymentJobState{ID: "deploy-stable-id", Kind: "deploy", Status: "succeeded"})
	}))
	defer server.Close()

	if err := testDeploymentClient(server).executeWithID("deploy", "deploy-stable-id", "192.0.2.24", true); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 1 || len(bodies) != 1 || !strings.Contains(bodies[0], `"deployment_id":"deploy-stable-id"`) {
		t.Fatalf("stable identity was not sent exactly once: posts=%d bodies=%v", posts.Load(), bodies)
	}
}

func TestDeploymentDeadlineCoversIndefinitelyOpenProgressStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
	}))
	defer server.Close()

	client := testDeploymentClient(server)
	client.maxWait = 50 * time.Millisecond
	started := time.Now()
	err := client.executeWithID("deploy", "deploy-open-stream", "192.0.2.25", true)
	if err == nil || !strings.Contains(err.Error(), "timed out after") {
		t.Fatalf("open stream deadline error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("open stream exceeded bounded deadline: %s", elapsed)
	}
}
