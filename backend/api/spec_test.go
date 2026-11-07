package api

import (
	"context"
	"slices"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

// permissionCatalog mirrors docs/02-architecture.md, section 5.1.
var permissionCatalog = []string{
	"project.view", "project.view_finished", "project.create", "project.update", "project.finish", "project.delete",
	"participant.view", "participant.edit", "participant.print", "participant.export", "participant.import",
	"participant.delete", "participant.clear",
	"user.view", "user.manage", "role.manage", "audit.view", "system.view",
}

// errorCodes mirrors the error table of docs/04-api.md, section 1.
var errorCodes = []string{
	"VALIDATION", "UNAUTHENTICATED", "AUTH_UNAVAILABLE", "TOKEN_EXPIRED", "TOKEN_STALE", "REFRESH_INVALID",
	"BAD_CREDENTIALS", "FORBIDDEN", "PASSWORD_CHANGE_REQUIRED", "NOT_FOUND", "ROW_LOCKED", "VERSION_CONFLICT",
	"PROJECT_FINISHED", "LAST_ADMIN", "ROLE_IN_USE", "ROLE_SYSTEM", "TOO_LARGE", "UNSUPPORTED_MEDIA",
	"IMAGE_INVALID", "RATE_LIMITED", "DISK_LOW", "INTERNAL",
}

func loadSpec(t *testing.T) *openapi3.T {
	t.Helper()
	doc, err := openapi3.NewLoader().LoadFromData(Spec)
	if err != nil {
		t.Fatalf("load spec: %v", err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("validate spec: %v", err)
	}
	return doc
}

func TestSpecIsValid(t *testing.T) {
	doc := loadSpec(t)
	if len(doc.Paths.Map()) == 0 {
		t.Fatal("spec has no paths")
	}
}

func TestOperationsHaveIDsAndPermissions(t *testing.T) {
	doc := loadSpec(t)
	seen := map[string]string{}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			where := method + " " + path
			if op.OperationID == "" {
				t.Errorf("%s: missing operationId", where)
			} else if prev, dup := seen[op.OperationID]; dup {
				t.Errorf("%s: operationId %q duplicates %s", where, op.OperationID, prev)
			} else {
				seen[op.OperationID] = where
			}
			if len(op.Tags) == 0 {
				t.Errorf("%s: missing tags", where)
			}

			// An explicit empty security list marks a public operation.
			public := op.Security != nil && len(*op.Security) == 0
			raw, has := op.Extensions["x-required-permissions"]
			if public {
				continue
			}
			if !has {
				t.Errorf("%s: protected operation lacks x-required-permissions", where)
				continue
			}
			list, ok := raw.([]any)
			if !ok {
				t.Errorf("%s: x-required-permissions must be a list, got %T", where, raw)
				continue
			}
			for _, v := range list {
				code, _ := v.(string)
				if !slices.Contains(permissionCatalog, code) {
					t.Errorf("%s: unknown permission %q", where, code)
				}
			}
		}
	}
}

func TestErrorCodesBelongToEnum(t *testing.T) {
	doc := loadSpec(t)

	enum := doc.Components.Schemas["ErrorCode"].Value.Enum
	got := make([]string, 0, len(enum))
	for _, v := range enum {
		got = append(got, v.(string))
	}
	slices.Sort(got)
	want := slices.Clone(errorCodes)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("ErrorCode enum differs from the documented codes:\n got  %v\n want %v", got, want)
	}

	check := func(where string, resp *openapi3.Response) {
		if resp == nil {
			return
		}
		for _, mt := range resp.Content {
			values := []any{mt.Example}
			for _, ex := range mt.Examples {
				if ex.Value != nil {
					values = append(values, ex.Value.Value)
				}
			}
			for _, v := range values {
				code := exampleErrorCode(v)
				if code != "" && !slices.Contains(errorCodes, code) {
					t.Errorf("%s: example uses undocumented error code %q", where, code)
				}
			}
		}
	}
	for name, ref := range doc.Components.Responses {
		check("components/responses/"+name, ref.Value)
	}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			for status, ref := range op.Responses.Map() {
				check(method+" "+path+" "+status, ref.Value)
			}
		}
	}
}

func exampleErrorCode(v any) string {
	root, _ := v.(map[string]any)
	inner, _ := root["error"].(map[string]any)
	code, _ := inner["code"].(string)
	return code
}

func TestSecuritySchemes(t *testing.T) {
	doc := loadSpec(t)
	if s := doc.Components.SecuritySchemes["bearerAuth"]; s == nil || s.Value.Scheme != "bearer" || s.Value.BearerFormat != "JWT" {
		t.Error("bearerAuth must be an http bearer JWT scheme")
	}
	if s := doc.Components.SecuritySchemes["refreshCookie"]; s == nil || s.Value.In != "cookie" || s.Value.Name != "tip_rt" {
		t.Error("refreshCookie must be an apiKey in cookie tip_rt")
	}
	if len(doc.Security) != 1 {
		t.Error("bearerAuth must be applied globally")
	}
}
