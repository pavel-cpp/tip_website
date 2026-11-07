package domain

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

func TestParticipantEdited(t *testing.T) {
	base := Participant{ID: "r1", ProjectID: "p1", Number: 7, Name: "old", Phone: "1", Version: 3, UpdatedBy: "u0"}
	now := t0.Add(time.Minute)

	tests := []struct {
		name        string
		nameIn      string
		phoneIn     string
		version     int
		wantName    string
		wantPhone   string
		wantErr     *Error
		wantFieldIn string
	}{
		{name: "happy path", nameIn: "Azam", phoneIn: "+998 90", version: 3, wantName: "Azam", wantPhone: "+998 90"},
		{name: "trims spaces", nameIn: "  Azam  ", phoneIn: " 1 ", version: 3, wantName: "Azam", wantPhone: "1"},
		{name: "clears values", nameIn: "", phoneIn: "", version: 3, wantName: "", wantPhone: ""},
		{name: "max name", nameIn: strings.Repeat("я", 200), phoneIn: "", version: 3, wantName: strings.Repeat("я", 200)},
		{name: "max phone", nameIn: "", phoneIn: strings.Repeat("9", 40), version: 3, wantPhone: strings.Repeat("9", 40)},
		{name: "stale version", nameIn: "x", version: 2, wantErr: ErrVersionConflict},
		{name: "future version", nameIn: "x", version: 4, wantErr: ErrVersionConflict},
		{name: "name too long", nameIn: strings.Repeat("a", 201), version: 3, wantErr: ErrValidation, wantFieldIn: "name"},
		{name: "phone too long", phoneIn: strings.Repeat("9", 41), version: 3, wantErr: ErrValidation, wantFieldIn: "phone"},
		{name: "validation wins over conflict", nameIn: strings.Repeat("a", 201), version: 99, wantErr: ErrValidation, wantFieldIn: "name"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := base.Edited(tt.nameIn, tt.phoneIn, tt.version, "u1", now)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				if tt.wantFieldIn != "" {
					var ve *ValidationError
					if !errors.As(err, &ve) || ve.Fields[0].Field != tt.wantFieldIn {
						t.Fatalf("field = %+v", ve)
					}
				}
				if got != (Participant{}) {
					t.Fatalf("error must come with a zero value, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected: %v", err)
			}
			if got.Name != tt.wantName || got.Phone != tt.wantPhone || got.Version != 4 ||
				got.UpdatedBy != "u1" || !got.UpdatedAt.Equal(now) {
				t.Fatalf("got %+v", got)
			}
			if got.ID != base.ID || got.ProjectID != base.ProjectID || got.Number != base.Number {
				t.Fatalf("identity fields changed: %+v", got)
			}
		})
	}
	if base.Version != 3 || base.Name != "old" {
		t.Fatal("Edited must not mutate the receiver")
	}
}

func TestAllocateNumbers(t *testing.T) {
	tests := []struct {
		name         string
		next, count  int
		first, after int
		wantErr      bool
	}{
		{"first batch", 1, 10, 1, 11, false},
		{"continues counter", 101, 1, 101, 102, false},
		{"max batch", 1, MaxAddRows, 1, MaxAddRows + 1, false},
		{"zero count", 1, 0, 0, 0, true},
		{"negative count", 1, -3, 0, 0, true},
		{"over max batch", 1, MaxAddRows + 1, 0, 0, true},
		{"bad counter", 0, 1, 0, 0, true},
		{"negative counter", -1, 1, 0, 0, true},
		{"overflow guard", math.MaxInt32 - 5, 10, 0, 0, true},
		{"just fits", math.MaxInt32 - 10, 10, math.MaxInt32 - 10, math.MaxInt32, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			first, after, err := AllocateNumbers(tt.next, tt.count)
			if tt.wantErr {
				if !errors.Is(err, ErrValidation) {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err != nil || first != tt.first || after != tt.after {
				t.Fatalf("got (%d, %d, %v)", first, after, err)
			}
		})
	}
}
