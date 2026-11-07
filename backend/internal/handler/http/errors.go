// Package http is the public REST transport: router, middleware and the JSON error envelope.
package http

import (
	"encoding/json"
	"net/http"
)

// Error codes shared by the skeleton; business codes are added with the endpoints.
const (
	codeInternal         = "INTERNAL"
	codeNotFound         = "NOT_FOUND"
	codeMethodNotAllowed = "METHOD_NOT_ALLOWED"
)

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details"`
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

// writeError writes the standard error envelope {"error":{"code","message","details"}}.
// A nil details value is rendered as an empty object so clients can always read the field.
func writeError(w http.ResponseWriter, status int, code, message string, details any) {
	if details == nil {
		details = struct{}{}
	}
	writeJSON(w, status, errorEnvelope{Error: errorBody{Code: code, Message: message, Details: details}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) // the status is already sent; a failed write has no better recovery
}
