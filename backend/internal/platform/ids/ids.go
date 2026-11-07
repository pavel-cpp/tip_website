// Package ids provides the production implementation of service.IDGen.
package ids

import "github.com/google/uuid"

// UUIDv7 generates time-sortable UUIDs.
type UUIDv7 struct{}

// NewID returns a new UUIDv7 string. Generation only fails when the system entropy source
// does, which is unrecoverable, so it panics like the rest of the ecosystem does.
func (UUIDv7) NewID() string { return uuid.Must(uuid.NewV7()).String() }
