package api

import (
	"context"
	"sync"
	"time"

	"github.com/youeye-platform/YouEye/spine/internal/config"
)

// pamGate is the backstop in front of PAM password checks (`/api/auth/verify`, YE-164). The Control Panel's sign-in
// limits (YE-149) are the front door; this one never locks a username and never refuses the right password:
//   - only failures count, per username, within the window; a success clears them;
//   - past `max_attempts` failures, the answer to a wrong password is held (1 s per further failure, at most 5 s),
//     after the check has given back its slot;
//   - at most `checkSlots` checks start and run at once. A check gives its slot back after `slotBudget` even while
//     pamtester still runs (a wrong password sits in PAM's own fail delay, about 2–3 s), so wrong passwords cannot
//     keep the slots and the owner waits at most about `slotBudget` behind them. At most `maxRunning` pamtester
//     processes run in all;
//   - at most `maxWaiting` requests wait, each at most `maxWait`. Past either, the answer is 503 with Retry-After,
//     never 429, never a hang.
//
// Nothing is stored: the counts live in memory, and the config keys keep their names and defaults.
type pamGate struct {
	mu          sync.Mutex
	failures    map[string][]time.Time
	maxFailures int
	window      time.Duration

	slots   chan struct{} // checks starting or within their slot budget
	running chan struct{} // pamtester processes
	waiting chan struct{} // requests waiting for a slot

	slotBudget time.Duration
	maxWait    time.Duration
	holdStep   time.Duration
	holdMax    time.Duration

	check func(ctx context.Context, username, password string) bool
	now   func() time.Time
	sleep func(ctx context.Context, d time.Duration)
}

const (
	pamCheckSlots  = 4
	pamMaxRunning  = 32
	pamMaxWaiting  = 64
	pamMaxWait     = 10 * time.Second
	pamSlotBudget  = 750 * time.Millisecond
	pamHoldStep    = time.Second
	pamHoldMaximum = 5 * time.Second
)

// errPAMBusy: the gate's queue is full or the wait ran out. The handler answers 503 with Retry-After.
type errPAMBusy struct{ retryAfter time.Duration }

func (e errPAMBusy) Error() string { return "too many sign-in checks at once" }

func newPAMGate(cfg *config.Config) *pamGate {
	return newPAMGateSized(cfg, pamCheckSlots, pamMaxRunning, pamMaxWaiting)
}

func newPAMGateSized(cfg *config.Config, slots, running, waiting int) *pamGate {
	return &pamGate{
		failures:    make(map[string][]time.Time),
		maxFailures: cfg.API.Auth.MaxAttempts,
		window:      time.Duration(cfg.API.Auth.WindowMinutes) * time.Minute,
		slots:       make(chan struct{}, slots),
		running:     make(chan struct{}, running),
		waiting:     make(chan struct{}, waiting),
		slotBudget:  pamSlotBudget,
		maxWait:     pamMaxWait,
		holdStep:    pamHoldStep,
		holdMax:     pamHoldMaximum,
		check:       verifyPAMContext,
		now:         time.Now,
		sleep: func(ctx context.Context, d time.Duration) {
			timer := time.NewTimer(d)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
			}
		},
	}
}

// verify runs one password check through the gate. It returns whether PAM accepted the password and how many
// failures the username has left before its wrong answers are held; errPAMBusy when no slot came in time, or the
// request's context error when the caller went away while waiting.
func (g *pamGate) verify(ctx context.Context, username, password string) (bool, int, error) {
	if err := g.acquire(ctx); err != nil {
		return false, 0, err
	}
	result := make(chan bool, 1)
	go func() {
		defer func() { <-g.running }()
		result <- g.check(ctx, username, password)
	}()

	var authenticated bool
	budget := time.NewTimer(g.slotBudget)
	select {
	case authenticated = <-result:
		budget.Stop()
		<-g.slots
	case <-budget.C:
		// Still running: most likely PAM's fail delay. The slot goes to the next request; the process keeps its
		// place among the running ones.
		<-g.slots
		authenticated = <-result
	}

	if authenticated {
		g.clear(username)
		return true, g.maxFailures, nil
	}
	count := g.fail(username)
	if hold := g.holdFor(count); hold > 0 {
		g.sleep(ctx, hold) // after the slot is back: wrong answers wait, the gate does not
	}
	remaining := g.maxFailures - count
	if remaining < 0 {
		remaining = 0
	}
	return false, remaining, nil
}

// acquire takes a running-process place and a check slot, waiting at most maxWait among at most maxWaiting.
func (g *pamGate) acquire(ctx context.Context) error {
	select {
	case g.waiting <- struct{}{}:
	default:
		return errPAMBusy{retryAfter: g.maxWait}
	}
	defer func() { <-g.waiting }()

	timer := time.NewTimer(g.maxWait)
	defer timer.Stop()
	select {
	case g.running <- struct{}{}:
	case <-timer.C:
		return errPAMBusy{retryAfter: g.maxWait}
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case g.slots <- struct{}{}:
		return nil
	case <-timer.C:
		<-g.running
		return errPAMBusy{retryAfter: g.maxWait}
	case <-ctx.Done():
		<-g.running
		return ctx.Err()
	}
}

// holdFor: how long the answer to the count-th failure is held.
func (g *pamGate) holdFor(count int) time.Duration {
	over := count - g.maxFailures
	if over <= 0 {
		return 0
	}
	hold := time.Duration(over) * g.holdStep
	if hold > g.holdMax {
		hold = g.holdMax
	}
	return hold
}

// fail records a failure for the username and returns its failures within the window.
func (g *pamGate) fail(username string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	recent := g.recent(g.failures[username], now)
	recent = append(recent, now)
	g.failures[username] = recent
	return len(recent)
}

func (g *pamGate) clear(username string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.failures, username)
}

// failuresLeft: failures the username has left before its wrong answers are held.
func (g *pamGate) failuresLeft(username string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	left := g.maxFailures - len(g.recent(g.failures[username], g.now()))
	if left < 0 {
		return 0
	}
	return left
}

func (g *pamGate) recent(times []time.Time, now time.Time) []time.Time {
	cutoff := now.Add(-g.window)
	kept := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	return kept
}

// cleanup forgets usernames with no failure in the window (called periodically).
func (g *pamGate) cleanup() {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	for username, times := range g.failures {
		if recent := g.recent(times, now); len(recent) == 0 {
			delete(g.failures, username)
		} else {
			g.failures[username] = recent
		}
	}
}
