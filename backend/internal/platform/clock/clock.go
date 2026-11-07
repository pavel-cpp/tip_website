// Package clock provides the production implementation of service.Clock.
package clock

import "time"

// System reads the wall clock.
type System struct{}

// Now returns the current time in UTC.
func (System) Now() time.Time { return time.Now().UTC() }
