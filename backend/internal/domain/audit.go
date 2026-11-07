package domain

import "time"

// Audit action names for participant tables. Other areas add their own names.
const (
	ActionTicketsPrint       = "tickets.print"
	ActionParticipantsDelete = "participants.delete"
	ActionParticipantsClear  = "participants.clear"
	ActionParticipantsImport = "participants.import"
)

// AuditEntry is one audit log record. Meta carries ids and counts only, never
// names, phones or other personal data.
type AuditEntry struct {
	ID int64
	At time.Time
	// ActorID is empty for system actions or after the user was deleted.
	ActorID string
	// ActorLogin is a snapshot taken when the entry was written.
	ActorLogin string
	Action     string
	ProjectID  string
	EntityID   string
	Meta       map[string]any
	// IP is the client address in text form, empty when unknown.
	IP string
}

// AuditFilter narrows an audit listing. Zero fields mean "no restriction".
type AuditFilter struct {
	ProjectID string
	ActorID   string
	// Before restricts the result to entries with an id lower than this value.
	Before int64
	// Limit is the page size the repository must honour exactly.
	Limit int
}

// Audit retention defaults (docs/03-database.md, section 4).
const (
	DefaultAuditRetentionDays = 30
	DefaultAuditMaxRows       = 100_000
	// AuditPurgeBatch is the number of rows deleted per statement so the table is never locked for long.
	AuditPurgeBatch = 5000
)
