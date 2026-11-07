// Package api embeds the OpenAPI contract so that the binary can serve it
// (Swagger UI and /api/openapi.yaml) without reading files at runtime.
package api

import _ "embed"

// Spec is the raw OpenAPI 3.1 document (openapi.yaml).
//
//go:embed openapi.yaml
var Spec []byte
