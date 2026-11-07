package logging

// Field names shared by logs, LogQL queries and dashboards. Keep them stable.
const (
	FieldTime      = "ts"
	FieldLevel     = "level"
	FieldMessage   = "msg"
	FieldRequestID = "request_id"
	FieldMethod    = "method"
	FieldRoute     = "route"
	FieldStatus    = "status"
	FieldDurMS     = "dur_ms"
	FieldBytes     = "bytes"
	FieldUserID    = "user_id"
	FieldRole      = "role"
	FieldIP        = "ip"
	FieldError     = "error"
	FieldStack     = "stack"
	FieldComponent = "component"
	FieldSampled   = "sampled"
	FieldWSConn    = "ws_conn"
	FieldProjectID = "project_id"
	FieldSource    = "source"
)
