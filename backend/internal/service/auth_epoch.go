package service

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
)

// Epoch is the in-memory copy of the permission epoch (authz_state). The monolith runs as a
// single instance, so one process-wide copy is authoritative: access tokens carrying a lower
// epoch are rejected with TOKEN_STALE without touching the database.
type Epoch struct {
	value atomic.Int64

	mu   sync.Mutex
	subs []func(epoch int64)
}

// NewEpoch loads the current epoch from the store.
func NewEpoch(ctx context.Context, store AuthzState) (*Epoch, error) {
	e := &Epoch{}
	if err := e.Reload(ctx, store); err != nil {
		return nil, err
	}
	return e, nil
}

// Load returns the current epoch.
func (e *Epoch) Load() int64 { return e.value.Load() }

// Reload re-reads the epoch from the store.
func (e *Epoch) Reload(ctx context.Context, store AuthzState) error {
	v, err := store.Epoch(ctx)
	if err != nil {
		return fmt.Errorf("load permission epoch: %w", err)
	}
	e.Set(v)
	return nil
}

// Set raises the cached epoch (it never moves backwards) and notifies subscribers when it grew.
// Services call it after the transaction that bumped the epoch has committed.
func (e *Epoch) Set(v int64) {
	for {
		cur := e.value.Load()
		if v <= cur {
			return
		}
		if e.value.CompareAndSwap(cur, v) {
			break
		}
	}
	e.mu.Lock()
	subs := append([]func(int64){}, e.subs...)
	e.mu.Unlock()
	for _, fn := range subs {
		fn(v)
	}
}

// Subscribe registers fn to be called whenever the epoch grows (the WebSocket hub uses it to
// send "reauth" frames). fn must not block.
func (e *Epoch) Subscribe(fn func(epoch int64)) {
	e.mu.Lock()
	e.subs = append(e.subs, fn)
	e.mu.Unlock()
}
