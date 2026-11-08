package domain

import (
	"strings"
	"testing"
)

func TestLeastUsedColor(t *testing.T) {
	if got := LeastUsedColor(nil); got != UserPalette[0] {
		t.Fatalf("empty set = %q, want the first palette colour", got)
	}
	taken := []string{UserPalette[0], UserPalette[1], UserPalette[2]}
	if got := LeastUsedColor(taken); got != UserPalette[3] {
		t.Fatalf("got %q, want first unused %q", got, UserPalette[3])
	}
	// Hand-picked colours and letter case do not confuse the count.
	taken = append(taken, "#112233", strings.ToUpper(UserPalette[3]), UserPalette[4], UserPalette[5], UserPalette[5])
	if got := LeastUsedColor(taken); got != UserPalette[0] {
		t.Fatalf("got %q, want the earliest of the least used colours", got)
	}
}

func TestLeastUsedColorSpreadsEvenly(t *testing.T) {
	var taken []string
	for i := 0; i < 4*len(UserPalette); i++ {
		taken = append(taken, LeastUsedColor(taken))
	}
	counts := map[string]int{}
	for _, c := range taken {
		counts[c]++
	}
	if len(counts) != len(UserPalette) {
		t.Fatalf("used %d colours: %v", len(counts), counts)
	}
	for c, n := range counts {
		if n != 4 {
			t.Fatalf("%s used %d times, want 4", c, n)
		}
	}
}
