package domain

import (
	"strings"
	"testing"
)

func TestDetectFontFormat(t *testing.T) {
	pad := func(magic string) []byte { return append([]byte(magic), make([]byte, 16)...) }
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{"ttf", pad("\x00\x01\x00\x00"), FontFormatTTF},
		{"ttf true", pad("true"), FontFormatTTF},
		{"otf", pad("OTTO"), FontFormatOTF},
		{"woff2", pad("wOF2"), FontFormatWOFF2},
		{"woff1 is refused", pad("wOFF"), ""},
		{"png", pad("\x89PNG"), ""},
		{"too short", []byte("OTTO"), ""},
		{"empty", nil, ""},
	}
	for _, tc := range tests {
		if got := DetectFontFormat(tc.data); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestValidateFontName(t *testing.T) {
	if got, err := ValidateFontName("  My Font  "); err != nil || got != "My Font" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("a", MaxFontNameLen+1), "a\x00b"} {
		if _, err := ValidateFontName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if _, err := ValidateFontName(strings.Repeat("ю", MaxFontNameLen)); err != nil {
		t.Errorf("60 runes rejected: %v", err)
	}
}

func TestCustomFontRef(t *testing.T) {
	const id = "0198f2f0-7a3c-7c1e-9b57-2f4d5a6b7c8d"
	ref := CustomFontRef(id)
	if got, ok := CustomFontID(ref); !ok || got != id {
		t.Fatalf("round trip failed: %q %v", got, ok)
	}
	for _, bad := range []string{"Inter", "custom:", "custom:abc", "custom:" + strings.ToUpper(id), "Custom:" + id, id} {
		if IsCustomFont(bad) {
			t.Errorf("%q accepted as a custom font", bad)
		}
	}
	p := goodPlaceholder()
	p.Font = ref
	if err := p.Validate("p"); err != nil {
		t.Errorf("custom font reference rejected: %v", err)
	}
	p.Font = "custom:nope"
	if err := p.Validate("p"); err == nil {
		t.Error("malformed custom reference accepted")
	}
}
