package client

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const DefaultSpineSocket = "/var/run/spine/spine.sock"

// SpineClient talks to the Spine API over its Unix socket.
type SpineClient struct {
	socketPath string
	httpClient *http.Client
}

func NewSpineClient() *SpineClient {
	sock := DefaultSpineSocket
	return &SpineClient{
		socketPath: sock,
		httpClient: &http.Client{
			Transport: &http.Transport{
				DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
					return net.DialTimeout("unix", sock, 5*time.Second)
				},
			},
			Timeout: 2 * time.Minute,
		},
	}
}

func (c *SpineClient) Available() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://spine/api/health", nil)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// Get performs a GET request to the Spine API and returns the parsed JSON.
func (c *SpineClient) Get(path string) (map[string]interface{}, error) {
	resp, err := c.httpClient.Get("http://spine" + path)
	if err != nil {
		return nil, fmt.Errorf("spine unreachable: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("spine returned %d: %s", resp.StatusCode, string(body))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("invalid spine response: %w", err)
	}
	return result, nil
}

// GetRaw performs a GET and returns the raw response body.
func (c *SpineClient) GetRaw(path string) ([]byte, error) {
	resp, err := c.httpClient.Get("http://spine" + path)
	if err != nil {
		return nil, fmt.Errorf("spine unreachable: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("spine returned %d: %s", resp.StatusCode, string(body))
	}
	return body, nil
}

// Post performs a POST to the Spine API.
func (c *SpineClient) Post(path string, payload interface{}) (map[string]interface{}, error) {
	var bodyReader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		bodyReader = strings.NewReader(string(data))
	}

	resp, err := c.httpClient.Post("http://spine"+path, "application/json", bodyReader)
	if err != nil {
		return nil, fmt.Errorf("spine unreachable: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("spine returned %d: %s", resp.StatusCode, string(body))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		// Some endpoints return plain text
		return map[string]interface{}{"message": string(body)}, nil
	}
	return result, nil
}

// PostStream sends a POST and streams the SSE response line by line.
func (c *SpineClient) PostStream(path string, payload interface{}, handler func(line string)) error {
	var bodyReader io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		bodyReader = strings.NewReader(string(data))
	}

	resp, err := c.httpClient.Post("http://spine"+path, "application/json", bodyReader)
	if err != nil {
		return fmt.Errorf("spine unreachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("spine returned %d: %s", resp.StatusCode, string(body))
	}

	buf := make([]byte, 4096)
	var lineBuf string
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			lineBuf += string(buf[:n])
			for {
				idx := strings.Index(lineBuf, "\n")
				if idx < 0 {
					break
				}
				line := strings.TrimRight(lineBuf[:idx], "\r")
				lineBuf = lineBuf[idx+1:]
				if line != "" {
					handler(line)
				}
			}
		}
		if err != nil {
			break
		}
	}
	if lineBuf != "" {
		handler(lineBuf)
	}
	return nil
}
