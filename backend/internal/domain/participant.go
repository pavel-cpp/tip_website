package domain

import (
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

// Participant field limits; they mirror the schema CHECKs.
const (
	MaxParticipantNameLen  = 200
	MaxParticipantPhoneLen = 40
	// MaxAddRows is the largest batch of empty rows added by one request.
	MaxAddRows = 5000
)

// Participant is one row of a project's table.
type Participant struct {
	ID        string
	ProjectID string
	// Number is assigned once from the project counter and never reused.
	Number int
	Name   string
	Phone  string
	// Version grows by one on every write (optimistic concurrency).
	Version   int
	UpdatedBy string
	UpdatedAt time.Time
}

// Edited returns the participant with new name and phone and its version
// incremented. The input is trimmed and validated first. If expectedVersion is
// not the current version, ErrVersionConflict is returned and the caller
// should attach the current row via NewVersionConflict.
func (p Participant) Edited(name, phone string, expectedVersion int, byUser string, now time.Time) (Participant, error) {
	name = strings.TrimSpace(name)
	phone = strings.TrimSpace(phone)

	var errs []error
	if utf8.RuneCountInString(name) > MaxParticipantNameLen {
		errs = append(errs, fieldError("name", "must be at most 200 characters"))
	}
	if utf8.RuneCountInString(phone) > MaxParticipantPhoneLen {
		errs = append(errs, fieldError("phone", "must be at most 40 characters"))
	}
	if err := collect(errs...); err != nil {
		return Participant{}, err
	}
	if expectedVersion != p.Version {
		return Participant{}, ErrVersionConflict
	}
	p.Name = name
	p.Phone = phone
	p.Version++
	p.UpdatedBy = byUser
	p.UpdatedAt = now
	return p, nil
}

// AllocateNumbers reserves count consecutive participant numbers starting at
// the project's NextNumber counter. It returns the first allocated number and
// the new counter value. The repository performs the same arithmetic
// atomically in SQL; this helper defines the rule and is used for validation.
func AllocateNumbers(nextNumber, count int) (first, newNext int, err error) {
	if count < 1 || count > MaxAddRows {
		return 0, 0, fieldError("count", "must be 1-5000")
	}
	if nextNumber < 1 {
		return 0, 0, fieldError("nextNumber", "must be positive")
	}
	if nextNumber > math.MaxInt32-count {
		return 0, 0, fieldError("count", "participant number space exhausted")
	}
	return nextNumber, nextNumber + count, nil
}
