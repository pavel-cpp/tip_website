package domain

// EventType is the realtime frame type sent to WebSocket clients
// (docs/04-api.md, section 7).
type EventType string

// Realtime event types.
const (
	EventRowsUpsert    EventType = "rows.upsert"
	EventRowsDelete    EventType = "rows.delete"
	EventProjectUpdate EventType = "project.updated"
	EventReauth        EventType = "reauth"
)

// Event is a realtime notification. Implementations are plain data; routing to
// rooms and serialization are the Hub's and the handler's concern.
type Event interface {
	EventType() EventType
}

// RowsUpsertedEvent announces created or changed participant rows. Receivers
// apply a row only when its version is newer than the one they hold.
type RowsUpsertedEvent struct {
	Items []Participant
}

// RowsDeletedEvent announces deleted participant rows.
type RowsDeletedEvent struct {
	IDs []string
}

// ProjectUpdatedEvent announces a changed project (settings or status).
type ProjectUpdatedEvent struct {
	Project Project
}

// ReauthEvent asks connected clients to present a fresh token because roles or
// permissions changed. An empty UserID addresses every connection.
type ReauthEvent struct {
	UserID string
}

// RowsUpserted builds a RowsUpsertedEvent.
func RowsUpserted(items ...Participant) RowsUpsertedEvent { return RowsUpsertedEvent{Items: items} }

// RowsDeleted builds a RowsDeletedEvent.
func RowsDeleted(ids ...string) RowsDeletedEvent { return RowsDeletedEvent{IDs: ids} }

// ProjectUpdated builds a ProjectUpdatedEvent.
func ProjectUpdated(p Project) ProjectUpdatedEvent { return ProjectUpdatedEvent{Project: p} }

// Reauth builds a ReauthEvent for userID (empty for everyone).
func Reauth(userID string) ReauthEvent { return ReauthEvent{UserID: userID} }

// EventType implements Event.
func (RowsUpsertedEvent) EventType() EventType { return EventRowsUpsert }

// EventType implements Event.
func (RowsDeletedEvent) EventType() EventType { return EventRowsDelete }

// EventType implements Event.
func (ProjectUpdatedEvent) EventType() EventType { return EventProjectUpdate }

// EventType implements Event.
func (ReauthEvent) EventType() EventType { return EventReauth }
