package controlapi

import (
	"errors"
	"strings"
	"testing"
)

func TestScanSSEEventsSuccessfulStream(t *testing.T) {
	stream := strings.NewReader("data: {\"status\":\"progress\",\"message\":\"working\"}\n\n" +
		"data: {\"status\":\"success\",\"message\":\"done\"}\n\n")

	var events []SSEEvent
	err := scanSSEEvents(stream, func(event SSEEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("successful stream returned error: %v", err)
	}
	if len(events) != 2 || events[1].Status != "success" {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestScanSSEEventsDoneTerminatesBeforeTransportRestart(t *testing.T) {
	transportErr := errors.New("injected server restart")
	reader := &errorAfterDataReader{
		data: []byte("data: {\"status\":\"completed\",\"message\":\"done\"}\n\ndata: [DONE]\n\n"),
		err:  transportErr,
	}

	var events []SSEEvent
	err := scanSSEEvents(reader, func(event SSEEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("DONE stream returned error: %v", err)
	}
	if len(events) != 1 || events[0].Status != "completed" {
		t.Fatalf("unexpected events before DONE: %#v", events)
	}
}

func TestScanSSEEventsTerminalFailure(t *testing.T) {
	for _, status := range []string{"error", "failed"} {
		t.Run(status, func(t *testing.T) {
			stream := strings.NewReader("data: {\"status\":\"" + status + "\",\"message\":\"bounded diagnostic\"}\n\n" +
				"data: {\"status\":\"progress\",\"message\":\"cleanup observed\"}\n\n")

			var events []SSEEvent
			err := scanSSEEvents(stream, func(event SSEEvent) {
				events = append(events, event)
			})
			if !errors.Is(err, ErrSSETerminalFailure) {
				t.Fatalf("terminal %s returned %v, want %v", status, err, ErrSSETerminalFailure)
			}
			if len(events) != 2 || events[1].Message != "cleanup observed" {
				t.Fatalf("stream stopped before later cleanup event: %#v", events)
			}
			if strings.Contains(err.Error(), "bounded diagnostic") {
				t.Fatalf("terminal error leaked event payload: %v", err)
			}
		})
	}
}

func TestScanSSEEventsTerminalStageFailure(t *testing.T) {
	stream := strings.NewReader("data: {\"stage\":\"failed\",\"message\":\"bounded diagnostic\"}\n\n" +
		"data: {\"stage\":\"cleanup\",\"message\":\"cleanup observed\"}\n\n")

	var events []SSEEvent
	err := scanSSEEvents(stream, func(event SSEEvent) {
		events = append(events, event)
	})
	if !errors.Is(err, ErrSSETerminalFailure) {
		t.Fatalf("terminal stage returned %v, want %v", err, ErrSSETerminalFailure)
	}
	if len(events) != 2 || events[0].Stage != "failed" || events[1].Message != "cleanup observed" {
		t.Fatalf("unexpected stage events: %#v", events)
	}
}

func TestScanSSEEventsMalformedAndNonTerminalEvents(t *testing.T) {
	stream := strings.NewReader("data: not-json\n\n" +
		"data: {\"status\":\"warning\",\"message\":\"continuing\"}\n\n")

	var events []SSEEvent
	err := scanSSEEvents(stream, func(event SSEEvent) {
		events = append(events, event)
	})
	if err != nil {
		t.Fatalf("malformed/non-terminal stream returned error: %v", err)
	}
	if len(events) != 2 || events[0].Message != "not-json" || events[0].Status != "" {
		t.Fatalf("unexpected fallback events: %#v", events)
	}
}

func TestScanSSEEventsTransportErrorTakesPrecedence(t *testing.T) {
	transportErr := errors.New("injected transport failure")
	reader := &errorAfterDataReader{
		data: []byte("data: {\"status\":\"failed\",\"message\":\"bounded diagnostic\"}\n\n"),
		err:  transportErr,
	}

	handled := false
	err := scanSSEEvents(reader, func(event SSEEvent) {
		handled = true
	})
	if !handled {
		t.Fatal("terminal event was not delivered before the transport error")
	}
	if !errors.Is(err, transportErr) {
		t.Fatalf("returned %v, want transport error %v", err, transportErr)
	}
	if errors.Is(err, ErrSSETerminalFailure) {
		t.Fatalf("terminal failure masked transport error: %v", err)
	}
}

type errorAfterDataReader struct {
	data []byte
	err  error
}

func (r *errorAfterDataReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(p, r.data)
		r.data = r.data[n:]
		return n, nil
	}
	return 0, r.err
}
