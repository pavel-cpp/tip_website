package main

import (
	"context"
	"testing"

	"github.com/rs/zerolog"
)

func TestRunDispatch(t *testing.T) {
	for _, args := range [][]string{nil, {"bogus"}} {
		if err := run(args); err == nil {
			t.Errorf("run(%v) must fail", args)
		}
	}
	if err := run([]string{"admin"}); err != nil {
		t.Errorf("admin stub: %v", err)
	}
}

// A nil pool must produce an error, not a panic: migrations are applied against a real
// database in the migrations and platform/db integration tests.
func TestRunMigrationsRejectsNilDB(t *testing.T) {
	if err := runMigrations(context.Background(), nil, zerolog.Nop()); err == nil {
		t.Fatal("expected an error for a nil database")
	}
}
