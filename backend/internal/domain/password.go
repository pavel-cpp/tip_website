package domain

import "unicode/utf8"

// MinPasswordLen is the minimum password length in characters.
const MinPasswordLen = 8

// ValidatePassword enforces the password policy. Hashing is the job of the
// security platform package; this function never stores or logs its input.
func ValidatePassword(field, password string) error {
	if utf8.RuneCountInString(password) < MinPasswordLen {
		return fieldError(field, "must be at least 8 characters")
	}
	return nil
}
