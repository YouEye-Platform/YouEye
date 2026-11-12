package releasecache

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"
)

type scriptedTransport struct {
	errs  []error
	calls int
}

func (s *scriptedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	s.calls++
	if len(s.errs) > 0 {
		err := s.errs[0]
		s.errs = s.errs[1:]
		if err != nil {
			return nil, err
		}
	}
	return &http.Response{StatusCode: 200, Body: http.NoBody, Request: req}, nil
}

func fastRetries(t *testing.T) {
	t.Helper()
	old := connectRetryDelays
	connectRetryDelays = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { connectRetryDelays = old })
}

func TestConnectFailuresAreRetried(t *testing.T) {
	fastRetries(t)
	dnsTimeout := &net.DNSError{Err: "i/o timeout", Name: "git.example", IsTimeout: true}
	dial := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: network is unreachable")}
	next := &scriptedTransport{errs: []error{dnsTimeout, dial}}
	req, _ := http.NewRequest(http.MethodGet, "https://git.example/release", nil)
	resp, err := roundTripRetryingConnect(next, req)
	if err != nil || resp.StatusCode != 200 || next.calls != 3 {
		t.Fatalf("resp=%v err=%v calls=%d", resp, err, next.calls)
	}
}

func TestOtherFailuresAndUnknownHostsAreNotRetried(t *testing.T) {
	fastRetries(t)
	for _, failure := range []error{
		&net.DNSError{Err: "no such host", Name: "nope.example", IsNotFound: true},
		&net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset by peer")},
		errors.New("tls: handshake failure"),
	} {
		next := &scriptedTransport{errs: []error{failure}}
		req, _ := http.NewRequest(http.MethodGet, "https://git.example/release", nil)
		if _, err := roundTripRetryingConnect(next, req); err == nil || next.calls != 1 {
			t.Fatalf("%v: err=%v calls=%d", failure, err, next.calls)
		}
	}
}

func TestRetriesStopAfterTheLastDelayAndOnCancel(t *testing.T) {
	fastRetries(t)
	dnsTimeout := &net.DNSError{Err: "i/o timeout", Name: "git.example", IsTimeout: true}
	next := &scriptedTransport{errs: []error{dnsTimeout, dnsTimeout, dnsTimeout, dnsTimeout, dnsTimeout, dnsTimeout}}
	req, _ := http.NewRequest(http.MethodGet, "https://git.example/release", nil)
	if _, err := roundTripRetryingConnect(next, req); err == nil || next.calls != 5 {
		t.Fatalf("err=%v calls=%d", err, next.calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	next = &scriptedTransport{errs: []error{dnsTimeout, dnsTimeout}}
	req, _ = http.NewRequestWithContext(ctx, http.MethodGet, "https://git.example/release", nil)
	if _, err := roundTripRetryingConnect(next, req); err == nil || next.calls != 1 {
		t.Fatalf("cancelled: err=%v calls=%d", err, next.calls)
	}
}
