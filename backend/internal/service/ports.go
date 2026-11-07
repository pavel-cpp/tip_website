// Package service holds business logic. Interfaces it needs from the outside world are
// declared here and implemented by repository and platform packages.
package service

import (
	"context"
	"time"
)

// Clock abstracts time so tests do not depend on time.Now.
type Clock interface {
	// Now returns the current time.
	Now() time.Time
}

// IDGen produces unique, time-sortable identifiers for new entities.
type IDGen interface {
	// NewID returns a new UUID in its canonical string form.
	NewID() string
}

// Tx runs a unit of work atomically.
type Tx interface {
	// Do executes fn inside a transaction. The ctx passed to fn carries the transaction, so
	// repository calls made with it join the same transaction. A non-nil error from fn (or a
	// panic) rolls the transaction back; otherwise it is committed.
	Do(ctx context.Context, fn func(ctx context.Context) error) error
}
