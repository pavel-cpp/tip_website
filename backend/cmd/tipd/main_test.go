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

func TestRunMigrationsPlaceholder(t *testing.T) {
	if err := runMigrations(context.Background(), nil, zerolog.Nop()); err != nil {
		t.Fatal(err)
	}
}
