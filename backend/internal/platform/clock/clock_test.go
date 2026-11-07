package clock

import (
	"testing"
	"time"
)

func TestSystemNowIsUTCAndCurrent(t *testing.T) {
	now := System{}.Now()
	if now.Location() != time.UTC || time.Since(now) > time.Second {
		t.Errorf("unexpected clock value %v", now)
	}
}
