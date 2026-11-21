package controlapi

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	DefaultCPURL = "http://localhost:3000"
	CLITokenPath = "/var/lib/youeye/config/cli-token"
)

// ErrSSETerminalFailure reports that a Control Panel stream completed with a
// terminal error event. The event handler has already rendered the bounded,
// operator-facing diagnostics; this error deliberately carries no response
// payload so callers can return a truthful non-zero status without repeating
// potentially sensitive details.
var ErrSSETerminalFailure = errors.New("control panel operation failed")

// StreamLostError reports that the Control Panel accepted a streamed request and began answering, but the stream broke
// off (a dropped connection, an unexpected EOF) before it ended. The operation itself may still be running: the
// caller can follow it through the operation's status instead of reporting it as failed.
type StreamLostError struct{ Err error }

func (e *StreamLostError) Error() string {
	return "lost the Control Panel's progress stream: " + e.Err.Error()
}
func (e *StreamLostError) Unwrap() error { return e.Err }

// SSEEvent represents a server-sent event from the Control Panel.
type SSEEvent struct {
	Step       int    `json:"step,omitempty"`
	TotalSteps int    `json:"totalSteps,omitempty"`
	Status     string `json:"status,omitempty"`
	Stage      string `json:"stage,omitempty"`
	Message    string `json:"message,omitempty"`
	Detail     string `json:"detail,omitempty"`
	Progress   int    `json:"progress,omitempty"`
	AppID      string `json:"appId,omitempty"`
	Version    string `json:"version,omitempty"`
	// OperationID is the update operation the event belongs to (Market app updates, once it exists).
	OperationID string `json:"operationId,omitempty"`
}

// RequestTimeout bounds an ordinary Control Panel request, which the Control Panel answers at once.
// LongRequestTimeout bounds a request the Control Panel answers only when its work is done (Post with long set:
// orphan cleanup, uninstall, start and stop, update recovery). Both are variables so tests can shorten them.
var (
	RequestTimeout     = 2 * time.Minute
	LongRequestTimeout = 30 * time.Minute
)

// Client talks to the Control Panel HTTP API using a CLI token.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
	// longClient shares httpClient's transport, with LongRequestTimeout.
	longClient *http.Client
}

// HTTPError is a Control Panel answer that is not a success. Error keeps the raw form; Field reads a text field of
// the JSON body (the Control Panel answers refusals as {error, code, ...}).
type HTTPError struct {
	StatusCode int
	Body       []byte
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("control panel returned %d: %s", e.StatusCode, string(e.Body))
}

// Field is the text value of a top-level field of the JSON body, or "" when there is none.
func (e *HTTPError) Field(name string) string {
	var body map[string]interface{}
	if json.Unmarshal(e.Body, &body) != nil {
		return ""
	}
	value, _ := body[name].(string)
	return value
}

func NewClient() *Client {
	c := NewClientAt(DefaultCPURL, "")
	if data, err := os.ReadFile(CLITokenPath); err == nil {
		c.token = strings.TrimSpace(string(data))
	}
	return c
}

// NewClientAt is a client for the Control Panel at baseURL with this CLI token (tests use a local server).
func NewClientAt(baseURL, token string) *Client {
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		token:      token,
		httpClient: &http.Client{Timeout: RequestTimeout, Transport: transport},
		longClient: &http.Client{Timeout: LongRequestTimeout, Transport: transport},
	}
}

func (c *Client) Available() bool {
	req, _ := http.NewRequest("GET", c.baseURL+"/api/ping", nil)
	req.Header.Set("X-CLI-Token", c.token)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

func (c *Client) HasToken() bool {
	return c.token != ""
}

func (c *Client) doRequest(method, path string, body io.Reader) (*http.Response, error) {
	return c.doRequestWith(c.httpClient, method, path, body)
}

func (c *Client) doRequestWith(client *http.Client, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-CLI-Token", c.token)
	// CSRF routes pre-check that the header EXISTS before the CLI-token bypass
	// in verifyCSRFToken can apply — send a placeholder; the CLI token is the
	// real credential.
	req.Header.Set("X-CSRF-Token", "cli")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	var netErr net.Error
	if err != nil && errors.As(err, &netErr) && netErr.Timeout() {
		return nil, &TimeoutError{Limit: client.Timeout, Err: err}
	}
	return resp, err
}

// TimeoutError: the Control Panel took the request but did not answer within Limit. The work may still be running.
type TimeoutError struct {
	Limit time.Duration
	Err   error
}

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("the Control Panel did not answer within %s; the operation may still be running", e.Limit)
}
func (e *TimeoutError) Unwrap() error { return e.Err }

// unreachable wraps a failed request; a timeout keeps its own message (the Control Panel was reached).
func unreachable(err error) error {
	var timeout *TimeoutError
	if errors.As(err, &timeout) {
		return err
	}
	return fmt.Errorf("control panel unreachable: %w", err)
}

// Get returns parsed JSON from a Control Panel API GET endpoint.
func (c *Client) Get(path string) (map[string]interface{}, error) {
	resp, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, unreachable(err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		return nil, fmt.Errorf("unauthorized -- CLI token missing or invalid (run 'spine deploy' or check %s)", CLITokenPath)
	}
	if resp.StatusCode != 200 {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: data}
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("invalid response: %w", err)
	}
	return result, nil
}

// GetArray returns a JSON array from a Control Panel API GET endpoint.
func (c *Client) GetArray(path string) ([]interface{}, error) {
	resp, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, unreachable(err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		return nil, fmt.Errorf("unauthorized -- CLI token missing or invalid")
	}
	if resp.StatusCode != 200 {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: data}
	}

	var result []interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		var obj map[string]interface{}
		if err2 := json.Unmarshal(data, &obj); err2 == nil {
			for _, key := range []string{"apps", "users", "routes", "items", "data", "results", "services", "containers", "records", "languages"} {
				if arr, ok := obj[key]; ok {
					if a, ok := arr.([]interface{}); ok {
						return a, nil
					}
				}
			}
			return []interface{}{obj}, nil
		}
		return nil, fmt.Errorf("invalid response: %w", err)
	}
	return result, nil
}

// Post sends a POST to the Control Panel API.
func (c *Client) Post(path string, payload interface{}) (map[string]interface{}, error) {
	return c.post(c.httpClient, path, payload)
}

// PostLong is Post for a route that answers only when its work is done, bounded by LongRequestTimeout instead of
// RequestTimeout.
func (c *Client) PostLong(path string, payload interface{}) (map[string]interface{}, error) {
	return c.post(c.longClient, path, payload)
}

func (c *Client) post(client *http.Client, path string, payload interface{}) (map[string]interface{}, error) {
	var bodyReader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		bodyReader = strings.NewReader(string(data))
	}

	resp, err := c.doRequestWith(client, "POST", path, bodyReader)
	if err != nil {
		return nil, unreachable(err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		return nil, fmt.Errorf("unauthorized -- CLI token missing or invalid")
	}
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: data}
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return map[string]interface{}{"message": string(data)}, nil
	}
	return result, nil
}

// Patch sends a PATCH to the Control Panel API.
func (c *Client) Patch(path string, payload interface{}) (map[string]interface{}, error) {
	var bodyReader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		bodyReader = strings.NewReader(string(data))
	}

	resp, err := c.doRequest("PATCH", path, bodyReader)
	if err != nil {
		return nil, unreachable(err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: data}
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return map[string]interface{}{"message": string(data)}, nil
	}
	return result, nil
}

// Delete sends a DELETE to the Control Panel API.
func (c *Client) Delete(path string) (map[string]interface{}, error) {
	resp, err := c.doRequest("DELETE", path, nil)
	if err != nil {
		return nil, unreachable(err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: data}
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return map[string]interface{}{"message": string(data)}, nil
	}
	return result, nil
}

// PostSSEJSON sends a POST and streams raw SSE `data:` payloads (JSON strings)
// to the handler. Use this for endpoints whose events don't fit the numeric
// SSEEvent shape (e.g. the reconfigure engine's string step keys).
//
// Unlike the default client, this uses NO overall timeout — a server URL
// change restarts every installed app and can legitimately run for many
// minutes; only the response headers are deadline-bound.
func (c *Client) PostSSEJSON(path string, payload interface{}, handler func(raw string)) error {
	var bodyReader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		bodyReader = strings.NewReader(string(data))
	}

	req, err := http.NewRequest("POST", c.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("X-CLI-Token", c.token)
	req.Header.Set("X-CSRF-Token", "cli")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	streamClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig:       &tls.Config{InsecureSkipVerify: true},
			ResponseHeaderTimeout: 2 * time.Minute,
		},
	}
	resp, err := streamClient.Do(req)
	if err != nil {
		return fmt.Errorf("control panel unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("unauthorized -- CLI token missing or invalid")
	}
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		body, _ := io.ReadAll(resp.Body)
		return &HTTPError{StatusCode: resp.StatusCode, Body: body}
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		handler(strings.TrimPrefix(line, "data: "))
	}
	return scanner.Err()
}

// PostSSE sends a POST and streams SSE events, calling handler for each event.
func (c *Client) PostSSE(path string, payload interface{}, handler func(event SSEEvent)) error {
	var bodyReader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		bodyReader = strings.NewReader(string(data))
	}

	req, err := http.NewRequest("POST", c.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("X-CLI-Token", c.token)
	req.Header.Set("X-CSRF-Token", "cli")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	streamClient := &http.Client{Transport: &http.Transport{
		TLSClientConfig:       &tls.Config{InsecureSkipVerify: true},
		ResponseHeaderTimeout: 2 * time.Minute,
	}}
	resp, err := streamClient.Do(req)
	if err != nil {
		return fmt.Errorf("control panel unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("unauthorized -- CLI token missing or invalid")
	}
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		body, _ := io.ReadAll(resp.Body)
		return &HTTPError{StatusCode: resp.StatusCode, Body: body}
	}

	err = scanSSEEvents(resp.Body, handler)
	if err != nil && !errors.Is(err, ErrSSETerminalFailure) {
		return &StreamLostError{Err: err}
	}
	return err
}

func scanSSEEvents(reader io.Reader, handler func(event SSEEvent)) error {
	scanner := bufio.NewScanner(reader)
	terminalFailure := false
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		jsonStr := strings.TrimPrefix(line, "data: ")
		if jsonStr == "[DONE]" {
			if terminalFailure {
				return ErrSSETerminalFailure
			}
			return nil
		}
		var event SSEEvent
		if err := json.Unmarshal([]byte(jsonStr), &event); err != nil {
			event = SSEEvent{Message: jsonStr}
		}
		status := strings.ToLower(strings.TrimSpace(event.Status))
		if status == "" {
			status = strings.ToLower(strings.TrimSpace(event.Stage))
		}
		if status == "error" || status == "failed" {
			terminalFailure = true
		}
		handler(event)
	}
	if err := scanner.Err(); err != nil {
		// Preserve transport/scanner errors when both the stream and transport
		// fail. The terminal event was still delivered to the handler above.
		return err
	}
	if terminalFailure {
		return ErrSSETerminalFailure
	}
	return nil
}
