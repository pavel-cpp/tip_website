package ids

import (
	"testing"

	"github.com/google/uuid"
)

func TestUUIDv7(t *testing.T) {
	var g UUIDv7
	a, b := g.NewID(), g.NewID()
	if a == b {
		t.Fatal("ids must be unique")
	}
	u, err := uuid.Parse(a)
	if err != nil || u.Version() != 7 {
		t.Fatalf("not a v7 uuid: %q %v", a, err)
	}
	if a >= b {
		t.Errorf("ids generated in order must sort: %s %s", a, b)
	}
}
