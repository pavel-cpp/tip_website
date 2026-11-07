package domain

import "time"

// Row lock timings (docs/02-architecture.md, section 4.2).
const (
	// LockTTL is how long a lock lives without a heartbeat.
	LockTTL = 45 * time.Second
	// LockHeartbeat is the interval at which clients renew their locks.
	LockHeartbeat = 15 * time.Second
)

// RowLock is a short-lived exclusive edit lock on a participant row. It is a
// value: Renew returns a new lock. The Hub keeps locks in memory, so a lock
// that is not renewed simply expires.
type RowLock struct {
	RowID     string
	UserID    string
	ExpiresAt time.Time
}

// NewRowLock grants userID a lock on rowID that expires LockTTL after now.
func NewRowLock(rowID, userID string, now time.Time) RowLock {
	return RowLock{RowID: rowID, UserID: userID, ExpiresAt: now.Add(LockTTL)}
}

// Expired reports whether the lock has lapsed at `now`. The boundary instant
// counts as expired.
func (l RowLock) Expired(now time.Time) bool { return !now.Before(l.ExpiresAt) }

// OwnedBy reports whether userID holds the lock.
func (l RowLock) OwnedBy(userID string) bool { return l.UserID == userID }

// Renew extends the lock to LockTTL after now. Renewing never moves the
// expiry backwards.
func (l RowLock) Renew(now time.Time) RowLock {
	if next := now.Add(LockTTL); next.After(l.ExpiresAt) {
		l.ExpiresAt = next
	}
	return l
}

// EnsureAvailableTo returns ROW_LOCKED (with the owner in its details) when a
// live lock is held by someone other than userID. Expired and own locks pass.
func (l RowLock) EnsureAvailableTo(userID string, now time.Time) error {
	if l.Expired(now) || l.OwnedBy(userID) {
		return nil
	}
	return NewRowLocked(l.UserID)
}
