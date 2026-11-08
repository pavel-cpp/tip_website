package db

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestQueryTracerReportsStatement(t *testing.T) {
	var gotSQL string
	var gotDur time.Duration
	tr := queryTracer{obs: func(sql string, d time.Duration) { gotSQL, gotDur = sql, d }}

	ctx := tr.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: "SELECT 1"})
	time.Sleep(2 * time.Millisecond)
	tr.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	if gotSQL != "SELECT 1" || gotDur < time.Millisecond {
		t.Fatalf("observed %q after %v", gotSQL, gotDur)
	}
}

func TestQueryTracerIgnoresUnstartedQuery(t *testing.T) {
	called := false
	tr := queryTracer{obs: func(string, time.Duration) { called = true }}
	tr.TraceQueryEnd(context.Background(), nil, pgx.TraceQueryEndData{})
	if called {
		t.Fatal("observer must not run without a start record")
	}
}
