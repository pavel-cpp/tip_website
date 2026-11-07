package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

type fakeSystemProvider struct {
	st  service.SystemStatus
	err error
	got domain.Actor
}

func (f *fakeSystemProvider) Status(_ context.Context, a domain.Actor) (service.SystemStatus, error) {
	f.got = a
	return f.st, f.err
}

func systemRequest(h *SystemHandler, actor *domain.Actor) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/system", nil)
	ctx := logging.WithLogger(req.Context(), zerolog.Nop())
	if actor != nil {
		ctx = WithActor(ctx, *actor)
	}
	rec := httptest.NewRecorder()
	h.GetSystem(rec, req.WithContext(ctx))
	return rec
}

func TestGetSystemResponseShape(t *testing.T) {
	fake := &fakeSystemProvider{st: service.SystemStatus{
		Version: "1.0.0", Uptime: 125 * time.Second, DBSizeBytes: 42,
		Pool:     service.PoolStats{Open: 4, InUse: 1, Idle: 3, MaxOpen: 10},
		DiskFree: 100, DiskTotal: 1000, UploadsBytes: 7, ObsDays: 3, AuditDays: 30,
		Checks: []service.NamedCheckResult{{Name: "postgres", CheckResult: service.CheckResult{Status: service.CheckOK, Detail: "reachable"}}},
	}}
	a := domain.Actor{UserID: "u1"}
	rec := systemRequest(NewSystemHandler(fake), &a)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["version"] != "1.0.0" || got["uptime"] != float64(125) {
		t.Errorf("basics: %v", got)
	}
	db := got["db"].(map[string]any)
	pool := db["pool"].(map[string]any)
	if db["sizeBytes"] != float64(42) || pool["open"] != float64(4) || pool["inUse"] != float64(1) ||
		pool["idle"] != float64(3) || pool["maxOpen"] != float64(10) {
		t.Errorf("db: %v", db)
	}
	disk := got["disk"].(map[string]any)
	if disk["free"] != float64(100) || disk["total"] != float64(1000) {
		t.Errorf("disk: %v", disk)
	}
	ret := got["retention"].(map[string]any)
	if ret["obsDays"] != float64(3) || ret["auditDays"] != float64(30) {
		t.Errorf("retention: %v", ret)
	}
	if got["uploads"].(map[string]any)["sizeBytes"] != float64(7) {
		t.Errorf("uploads: %v", got["uploads"])
	}
	checks := got["checks"].([]any)
	c0 := checks[0].(map[string]any)
	if len(checks) != 1 || c0["name"] != "postgres" || c0["status"] != "ok" || c0["detail"] != "reachable" {
		t.Errorf("checks: %v", checks)
	}
	if fake.got.UserID != "u1" {
		t.Error("the authenticated actor must reach the service")
	}
}

func TestGetSystemNoChecksIsEmptyArray(t *testing.T) {
	rec := systemRequest(NewSystemHandler(&fakeSystemProvider{}), &domain.Actor{})
	var got map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if string(got["checks"]) != "[]" {
		t.Errorf("checks = %s, want []", got["checks"])
	}
}

func TestGetSystemUnauthenticated(t *testing.T) {
	rec := systemRequest(NewSystemHandler(&fakeSystemProvider{}), nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestGetSystemForbidden(t *testing.T) {
	rec := systemRequest(NewSystemHandler(&fakeSystemProvider{err: domain.ErrForbidden}), &domain.Actor{})
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}
