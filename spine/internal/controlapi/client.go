package controlapi

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	DefaultCPURL = "http://localhost:3000"
	CLITokenPath = "/var/lib/youeye/config/cli-token"
)

// SSEEvent represents a server-sent event from the Control Panel.
type SSEEvent struct {
	Step       int    `json:"step,omitempty"`
	TotalSteps int    `json:"totalSteps,omitempty"`
	Status     string `json:"status,omitempty"`
	Message    string `json:"message,omitempty"`
	Detail     string `json:"detail,omitempty"`
	Progress   int    `json:"progress,omitempty"`
	AppID      string `json:"appId,omitempty"`
	Version    string `json:"version,omitempty"`
}

// Client talks to the Control Panel HTTP API using a CLI token.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func NewClient() *Client {
	c := &Client{
		baseURL: DefaultCPURL,
		httpClient: &http.Client{
			Timeout: 2 * time.Minute,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}
	if data, err := os.ReadFile(CLITokenPath); err == nil {
		c.token = strings.TrimSpace(string(data))
	}
	return c
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
	req, err := http.NewRequest(method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-CLI-Token", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.httpClient.Do(req)
}

// Get returns parsed JSON from a Control Panel API GET endpoint.
func (c *Client) Get(path string) (map[string]interface{}, error) {
	resp, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, fmt.Errorf("control panel unreachable: %w", err)
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
		return nil, fmt.Errorf("control panel returned %d: %s", resp.StatusCode, string(data))
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
		return nil, fmt.Errorf("control panel unreachable: %w", err)
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
		return nil, fmt.Errorf("control panel returned %d: %s", resp.StatusCode, string(data))
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
	var bodyReader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		bodyReader = strings.NewReader(string(data))
	}

	resp, err := c.doRequest("POST", path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("control panel unreachable: %w", err)
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
		return nil, fmt.Errorf("control panel returned %d: %s", resp.StatusCode, string(data))
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
		return nil, fmt.Errorf("control panel unreachable: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("control panel returned %d: %s", resp.StatusCode, string(data))
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
		return nil, fmt.Errorf("control panel unreachable: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("control panel returned %d: %s", resp.StatusCode, string(data))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return map[string]interface{}{"message": string(data)}, nil
	}
	return result, nil
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

	resp, err := c.doRequest("POST", path, bodyReader)
	if err != nil {
		return fmt.Errorf("control panel unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		return fmt.Errorf("unauthorized -- CLI token missing or invalid")
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("control panel returned %d: %s", resp.StatusCode, string(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		jsonStr := strings.TrimPrefix(line, "data: ")
		var event SSEEvent
		if err := json.Unmarshal([]byte(jsonStr), &event); err != nil {
			event = SSEEvent{Message: jsonStr}
		}
		handler(event)
	}
	return scanner.Err()
}

// GetSSE sends a GET and streams SSE events.
func (c *Client) GetSSE(path string, handler func(event SSEEvent)) error {
	resp, err := c.doRequest("GET", path, nil)
	if err != nil {
		return fmt.Errorf("control panel unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("control panel returned %d: %s", resp.StatusCode, string(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		jsonStr := strings.TrimPrefix(line, "data: ")
		var event SSEEvent
		if err := json.Unmarshal([]byte(jsonStr), &event); err != nil {
			event = SSEEvent{Message: jsonStr}
		}
		handler(event)
	}
	return scanner.Err()
}
