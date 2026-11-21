package api

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A long backup or restore step must end when the Control Panel hangs up. The Control Panel sends its JSON body
// chunked, and the handlers decode one value from a limited reader, which leaves the body's end unread; Go's
// server then never notices that the caller went away. stepRequestContext reads the rest.
func TestStepRequestContextEndsWhenTheCallerHangsUp(t *testing.T) {
	ended := make(chan bool, 1)
	decoded := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			StagingDir string `json:"staging_dir"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil || request.StagingDir == "" {
			t.Errorf("decode: %v", err)
		}
		close(decoded)
		ctx := stepRequestContext(r)
		select {
		case <-ctx.Done():
			ended <- true
		case <-time.After(5 * time.Second):
			ended <- false
		}
	}))
	defer server.Close()

	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	body := `{"staging_dir":"/var/lib/youeye/backups/.staging/x"}`
	request := "POST /api/backup/apply-volumes HTTP/1.1\r\nHost: spine\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n" +
		"34\r\n" + body + "\r\n"
	if len(body) != 0x34 {
		t.Fatalf("body is %d bytes", len(body))
	}
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-decoded:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler did not read the request")
	}
	// The body's end arrives after the value was decoded, as a write of its own.
	if _, err := conn.Write([]byte("0\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	conn.Close()
	if !<-ended {
		t.Fatal("the step's context did not end when the caller hung up")
	}
}
