package api

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/config"
)

// YE-164: Spine's PAM gate is a backstop that slows, never locks.

func gateConfig(maxFailures int) *config.Config {
	cfg := config.Default()
	cfg.API.Auth.MaxAttempts = maxFailures
	cfg.API.Auth.WindowMinutes = 5
	return cfg
}

// holds records the gate's holds instead of sleeping.
type holds struct {
	mu   sync.Mutex
	list []time.Duration
}

func (h *holds) sleep(_ context.Context, d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.list = append(h.list, d)
}

func (h *holds) all() []time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]time.Duration(nil), h.list...)
}

func passwordIs(right string) func(context.Context, string, string) bool {
	return func(_ context.Context, _ string, password string) bool { return password == right }
}

func TestPAMGateCountsFailuresOnlyAndASuccessClearsThem(t *testing.T) {
	g := newPAMGate(gateConfig(2))
	g.check = passwordIs("right")
	h := &holds{}
	g.sleep = h.sleep
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		if ok, left, err := g.verify(ctx, "owner", "right"); !ok || err != nil || left != 2 {
			t.Fatalf("success %d = %v, %d, %v; successes must never use up the limit", i, ok, left, err)
		}
	}
	if _, left, _ := g.verify(ctx, "owner", "wrong"); left != 1 {
		t.Fatalf("left after one failure = %d, want 1", left)
	}
	if _, left, _ := g.verify(ctx, "owner", "wrong"); left != 0 {
		t.Fatalf("left after two failures = %d, want 0", left)
	}
	if got := g.failuresLeft("other"); got != 2 {
		t.Fatalf("another username's failures left = %d, want 2", got)
	}
	if ok, _, _ := g.verify(ctx, "owner", "right"); !ok {
		t.Fatal("the right password must pass")
	}
	if got := g.failuresLeft("owner"); got != 2 {
		t.Fatalf("a success clears the failures: left = %d, want 2", got)
	}
	if got := h.all(); len(got) != 0 {
		t.Fatalf("nothing past the threshold, nothing held: %v", got)
	}
}

func TestPAMGateNeverLocksTheRightPassword(t *testing.T) {
	g := newPAMGate(gateConfig(5))
	g.check = passwordIs("right")
	h := &holds{}
	g.sleep = h.sleep
	ctx := context.Background()

	for i := 0; i < 50; i++ {
		if ok, _, err := g.verify(ctx, "owner", "guess"); ok || err != nil {
			t.Fatalf("guess %d = %v, %v", i, ok, err)
		}
	}
	before := len(h.all())
	ok, _, err := g.verify(ctx, "owner", "right")
	if !ok || err != nil {
		t.Fatalf("after 50 failures the right password = %v, %v; want authenticated, no refusal", ok, err)
	}
	if len(h.all()) != before {
		t.Fatal("the right password is never held")
	}
}

func TestPAMGateHoldGrowsPerFailureAndStopsAtFiveSeconds(t *testing.T) {
	g := newPAMGate(gateConfig(2))
	g.check = passwordIs("right")
	h := &holds{}
	g.sleep = h.sleep
	for i := 0; i < 10; i++ {
		g.verify(context.Background(), "owner", "wrong")
	}
	want := []time.Duration{time.Second, 2 * time.Second, 3 * time.Second, 4 * time.Second,
		5 * time.Second, 5 * time.Second, 5 * time.Second, 5 * time.Second}
	got := h.all()
	if len(got) != len(want) {
		t.Fatalf("holds = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("holds = %v, want %v", got, want)
		}
	}
}

func TestPAMGateFailuresExpireAfterTheWindow(t *testing.T) {
	g := newPAMGate(gateConfig(1))
	g.check = passwordIs("right")
	g.sleep = (&holds{}).sleep
	now := time.Date(2026, 11, 24, 1, 0, 0, 0, time.UTC)
	g.now = func() time.Time { return now }
	g.verify(context.Background(), "owner", "wrong")
	if g.failuresLeft("owner") != 0 {
		t.Fatal("one failure recorded")
	}
	now = now.Add(6 * time.Minute)
	g.cleanup()
	if _, known := g.failures["owner"]; known {
		t.Fatal("cleanup forgets usernames without failures in the window")
	}
}

// slowWrong: wrong passwords stay in "PAM" until released (like pam_faildelay); the right one answers at once.
func slowWrong(release <-chan struct{}) func(context.Context, string, string) bool {
	return func(_ context.Context, _ string, password string) bool {
		if password == "right" {
			return true
		}
		<-release
		return false
	}
}

func TestPAMGateOwnerGetsASlotWithinASecondBehindFourSlowFailures(t *testing.T) {
	g := newPAMGate(gateConfig(5)) // production sizes: 4 slots, 750 ms slot budget
	release := make(chan struct{})
	g.check = slowWrong(release)
	g.sleep = (&holds{}).sleep
	var attackers sync.WaitGroup
	for i := 0; i < pamCheckSlots; i++ {
		attackers.Add(1)
		go func() { defer attackers.Done(); g.verify(context.Background(), "owner", "wrong") }()
	}
	waitForGate(t, func() bool { return len(g.slots) == pamCheckSlots })

	start := time.Now()
	ok, _, err := g.verify(context.Background(), "owner", "right")
	took := time.Since(start)
	if !ok || err != nil {
		t.Fatalf("owner = %v, %v", ok, err)
	}
	if took > 1100*time.Millisecond {
		t.Fatalf("the owner waited %v behind four slow failures; want about the slot budget (%v)", took, pamSlotBudget)
	}
	close(release)
	attackers.Wait()
	if len(g.slots) != 0 || len(g.running) != 0 || len(g.waiting) != 0 {
		t.Fatalf("everything given back: slots %d running %d waiting %d", len(g.slots), len(g.running), len(g.waiting))
	}
}

func TestPAMGateHoldsWrongAnswersOutsideTheSlots(t *testing.T) {
	g := newPAMGate(gateConfig(0)) // every failure is held
	g.check = passwordIs("right")
	unhold := make(chan struct{})
	var held sync.WaitGroup
	g.sleep = func(_ context.Context, _ time.Duration) { held.Done(); <-unhold }
	var attackers sync.WaitGroup
	for i := 0; i < pamCheckSlots*2; i++ {
		held.Add(1)
		attackers.Add(1)
		go func() { defer attackers.Done(); g.verify(context.Background(), "owner", "wrong") }()
	}
	held.Wait() // eight wrong answers are being held
	if len(g.slots) != 0 || len(g.running) != 0 {
		t.Fatalf("held answers keep no slot: slots %d running %d", len(g.slots), len(g.running))
	}
	start := time.Now()
	if ok, _, _ := g.verify(context.Background(), "owner", "right"); !ok || time.Since(start) > 200*time.Millisecond {
		t.Fatalf("the owner was not answered at once: %v after %v", ok, time.Since(start))
	}
	close(unhold)
	attackers.Wait()
}

func TestPAMGateQueueIsBoundedAndAnswersBusy(t *testing.T) {
	g := newPAMGateSized(gateConfig(5), 1, 1, 2)
	release := make(chan struct{})
	g.check = slowWrong(release)
	g.sleep = (&holds{}).sleep
	g.maxWait = 5 * time.Second
	go g.verify(context.Background(), "owner", "wrong") // holds the one running place
	waitForGate(t, func() bool { return len(g.running) == 1 })
	for i := 0; i < 2; i++ {
		go g.verify(context.Background(), "owner", "wrong")
	}
	waitForGate(t, func() bool { return len(g.waiting) == 2 })

	start := time.Now()
	_, _, err := g.verify(context.Background(), "owner", "right")
	var busy errPAMBusy
	if !errors.As(err, &busy) || time.Since(start) > 100*time.Millisecond {
		t.Fatalf("a full queue answers busy at once: %v after %v", err, time.Since(start))
	}
	if busy.retryAfter != g.maxWait {
		t.Fatalf("retry after %v, want %v", busy.retryAfter, g.maxWait)
	}
	close(release)
}

func TestPAMGateWaitIsBounded(t *testing.T) {
	g := newPAMGateSized(gateConfig(5), 1, 1, 8)
	release := make(chan struct{})
	defer close(release)
	g.check = slowWrong(release)
	g.sleep = (&holds{}).sleep
	g.slotBudget = 10 * time.Millisecond
	g.maxWait = 150 * time.Millisecond
	go g.verify(context.Background(), "owner", "wrong")
	waitForGate(t, func() bool { return len(g.running) == 1 })

	start := time.Now()
	_, _, err := g.verify(context.Background(), "owner", "right")
	var busy errPAMBusy
	if !errors.As(err, &busy) {
		t.Fatalf("a wait past maxWait answers busy, got %v", err)
	}
	if took := time.Since(start); took < 150*time.Millisecond || took > time.Second {
		t.Fatalf("waited %v, want about %v", took, g.maxWait)
	}
	if len(g.waiting) != 0 {
		t.Fatalf("the waiter left the queue: %d", len(g.waiting))
	}
	// A caller that goes away while waiting leaves too, and takes nothing with it.
	ctx, cancel := context.WithCancel(context.Background())
	g.maxWait = 5 * time.Second
	done := make(chan error, 1)
	go func() { _, _, err := g.verify(ctx, "owner", "right"); done <- err }()
	waitForGate(t, func() bool { return len(g.waiting) == 1 })
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter = %v", err)
	}
	if len(g.waiting) != 0 || len(g.running) != 1 || len(g.slots) != 0 {
		t.Fatalf("after the cancel: waiting %d running %d slots %d", len(g.waiting), len(g.running), len(g.slots))
	}
}

func TestPAMGateRunningProcessesAreCapped(t *testing.T) {
	g := newPAMGateSized(gateConfig(5), 4, 2, 8)
	release := make(chan struct{})
	defer close(release)
	g.check = slowWrong(release)
	g.sleep = (&holds{}).sleep
	g.slotBudget = 10 * time.Millisecond
	g.maxWait = 150 * time.Millisecond
	for i := 0; i < 2; i++ {
		go g.verify(context.Background(), "owner", "wrong")
	}
	waitForGate(t, func() bool { return len(g.running) == 2 && len(g.slots) == 0 })
	_, _, err := g.verify(context.Background(), "owner", "right")
	var busy errPAMBusy
	if !errors.As(err, &busy) {
		t.Fatalf("past the running cap, with slots free, the answer is busy: %v", err)
	}
}

func TestHandleAuthVerifyAnswers503WithRetryAfterNever429(t *testing.T) {
	s := testServer()
	s.pamGate = newPAMGateSized(gateConfig(5), 1, 1, 1)
	release := make(chan struct{})
	defer close(release)
	s.pamGate.check = slowWrong(release)
	s.pamGate.sleep = (&holds{}).sleep
	go s.pamGate.verify(context.Background(), "owner", "wrong")
	waitForGate(t, func() bool { return len(s.pamGate.running) == 1 })
	go s.pamGate.verify(context.Background(), "owner", "wrong")
	waitForGate(t, func() bool { return len(s.pamGate.waiting) == 1 })

	w := httptest.NewRecorder()
	s.handleAuthVerify(w, httptest.NewRequest("POST", "/api/auth/verify",
		bytes.NewBufferString(`{"username":"owner","password":"right"}`)))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "10" {
		t.Fatalf("busy answer = %d, Retry-After %q; want 503 and 10", w.Code, w.Header().Get("Retry-After"))
	}
}

func TestHandleAuthVerifyKeepsTheAnswerShape(t *testing.T) {
	s := testServer()
	s.pamGate.check = passwordIs("right")
	s.pamGate.sleep = (&holds{}).sleep
	for i := 0; i < 20; i++ {
		w := httptest.NewRecorder()
		s.handleAuthVerify(w, httptest.NewRequest("POST", "/api/auth/verify",
			bytes.NewBufferString(`{"username":"nobody-ye164","password":"wrong"}`)))
		if w.Code != http.StatusOK {
			t.Fatalf("failure %d answered %d; a wrong password is 200 authenticated:false, never 429", i, w.Code)
		}
	}
	w := httptest.NewRecorder()
	s.handleAuthVerify(w, httptest.NewRequest("POST", "/api/auth/verify",
		bytes.NewBufferString(`{"username":"nobody-ye164","password":"right"}`)))
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte(`"authenticated":true`)) ||
		!bytes.Contains(w.Body.Bytes(), []byte(`"username":"nobody-ye164"`)) || w.Header().Get("X-RateLimit-Remaining") == "" {
		t.Fatalf("answer = %d %s (X-RateLimit-Remaining %q)", w.Code, w.Body.String(), w.Header().Get("X-RateLimit-Remaining"))
	}
}

func waitForGate(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached within 3 s")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
