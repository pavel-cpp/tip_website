package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestNewWritesJSONAndFlushes(t *testing.T) {
	var out syncBuf
	l, closeFn := New(Options{Level: "info", Out: &out})
	l.Info().Str(FieldRequestID, "r1").Msg("hello")
	l.Debug().Msg("hidden")
	if err := closeFn(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for out.String() == "" && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(out.String())), &m); err != nil {
		t.Fatalf("not json: %q: %v", out.String(), err)
	}
	if m[FieldMessage] != "hello" || m[FieldRequestID] != "r1" || m[FieldLevel] != "info" || m[FieldTime] == nil {
		t.Errorf("unexpected record: %v", m)
	}
}

type slowWriter struct{ release chan struct{} }

func (w slowWriter) Write(p []byte) (int, error) {
	<-w.release
	return len(p), nil
}

func TestDroppedCallback(t *testing.T) {
	w := slowWriter{release: make(chan struct{})}
	var mu sync.Mutex
	dropped := 0
	l, closeFn := New(Options{Out: w, OnDropped: func(n int) {
		mu.Lock()
		dropped += n
		mu.Unlock()
	}})
	for range ringSize * 3 {
		l.Info().Msg("x")
	}
	close(w.release)
	_ = closeFn()
	mu.Lock()
	defer mu.Unlock()
	if dropped == 0 {
		t.Error("expected dropped events to be reported")
	}
}

func TestContextLogger(t *testing.T) {
	if got := FromContext(context.Background()); got.GetLevel() != zerolog.Disabled {
		t.Errorf("empty context should yield a disabled logger, level %v", got.GetLevel())
	}
	var buf bytes.Buffer
	ctx := WithLogger(context.Background(), zerolog.New(&buf))
	l := FromContext(ctx)
	l.Info().Msg("x")
	if buf.Len() == 0 {
		t.Error("logger from context did not write")
	}
}

func TestWarnSampler(t *testing.T) {
	var buf bytes.Buffer
	l := zerolog.New(&buf)
	s := NewWarnSampler()
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }

	for range 5 {
		s.Warn(&l).Msg("w")
	}
	if n := strings.Count(buf.String(), "\n"); n != 5 {
		t.Fatalf("burst should pass 5 events, got %d", n)
	}
	buf.Reset()
	for range 100 {
		s.Warn(&l).Msg("w")
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 10 {
		t.Fatalf("want every 10th of 100 events, got %d", len(lines))
	}
	if !strings.Contains(lines[0], `"sampled":true`) {
		t.Errorf("sampled events must be marked: %s", lines[0])
	}
	buf.Reset()
	now = now.Add(2 * time.Second)
	s.Warn(&l).Msg("w")
	if strings.Contains(buf.String(), "sampled") || buf.Len() == 0 {
		t.Errorf("a new period must restart the burst: %q", buf.String())
	}
}

func TestAdapters(t *testing.T) {
	var buf bytes.Buffer
	l := zerolog.New(&buf)
	NewStdLogger(l, "http").Printf("tls handshake error\n")
	Goose{L: l}.Printf("OK   %s\n", "001_init.sql")
	Goose{L: l}.Fatalf("boom")
	out := buf.String()
	for _, want := range []string{`"level":"warn"`, `"component":"http"`, `"msg":"tls handshake error"`,
		`"msg":"OK   001_init.sql"`, `"level":"error"`, `"component":"goose"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in %s", want, out)
		}
	}
}
