package service

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestRefreshReportsOutcomes(t *testing.T) {
	r := newRig(t, rigOpts{})
	ctx := context.Background()
	var got []string
	r.auth.OnRefresh = func(res string) { got = append(got, res) }

	s := r.login(t, "worker1", "worker-pass")
	n, err := r.auth.Refresh(ctx, s.Pair.RefreshToken) // rotation
	if err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(3 * time.Second)
	if _, err := r.auth.Refresh(ctx, s.Pair.RefreshToken); err != nil { // inside the replay window
		t.Fatal(err)
	}
	r.clock.Advance(11 * time.Second)
	_, _ = r.auth.Refresh(ctx, s.Pair.RefreshToken) // after the window: theft
	_, _ = r.auth.Refresh(ctx, n.Pair.RefreshToken) // chain already closed
	_, _ = r.auth.Refresh(ctx, "garbage")

	want := []string{RefreshOK, RefreshIdempotentReplay, RefreshReuseDetected, RefreshInvalid, RefreshInvalid}
	if !slices.Equal(got, want) {
		t.Fatalf("outcomes = %v, want %v", got, want)
	}
}

func TestRefreshReportsStoreErrors(t *testing.T) {
	r := newRig(t, rigOpts{})
	var got []string
	r.auth.OnRefresh = func(res string) { got = append(got, res) }
	s := r.login(t, "worker1", "worker-pass")
	r.store.down = errors.New("redis down")
	_, _ = r.auth.Refresh(context.Background(), s.Pair.RefreshToken)
	if !slices.Equal(got, []string{RefreshError}) {
		t.Fatalf("outcomes = %v", got)
	}
}
