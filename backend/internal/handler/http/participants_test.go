package http

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/http/gen"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
)

const (
	testProject = "0197a0aa-0000-7000-8000-000000000001"
	testRow     = "0197a0aa-0000-7000-8000-000000000002"
	testUser    = "0197a0aa-0000-7000-8000-000000000003"
)

type ptUnimpl struct{ gen.Unimplemented }

// ptComposite shows the intended wiring: the stream handlers sit one level above Unimplemented.
type ptComposite struct {
	ptUnimpl
	*ParticipantsHandler
	*AuditHandler
}

var _ gen.ServerInterface = ptComposite{}

type ptFakeSvc struct {
	listIn   service.ListInput
	listRes  service.ParticipantList
	addIn    service.AddInput
	updIn    service.UpdateInput
	delIDs   []string
	clearT   string
	printIDs []string
	impIn    service.ImportInput
	impBody  string
	impRes   service.ImportResult
	exportF  string
	err      error
}

func (f *ptFakeSvc) List(_ context.Context, _ domain.Actor, in service.ListInput) (service.ParticipantList, error) {
	f.listIn = in
	return f.listRes, f.err
}

func (f *ptFakeSvc) Add(_ context.Context, _ domain.Actor, in service.AddInput) ([]domain.Participant, error) {
	f.addIn = in
	return []domain.Participant{ptRow()}, f.err
}

func (f *ptFakeSvc) Update(_ context.Context, _ domain.Actor, in service.UpdateInput) (domain.Participant, error) {
	f.updIn = in
	return ptRow(), f.err
}

func (f *ptFakeSvc) Delete(_ context.Context, _ domain.Actor, _ string, ids []string) (int, error) {
	f.delIDs = ids
	return len(ids), f.err
}

func (f *ptFakeSvc) Clear(_ context.Context, _ domain.Actor, _ string, title string) (int, error) {
	f.clearT = title
	return 7, f.err
}

func (f *ptFakeSvc) LogPrinted(_ context.Context, _ domain.Actor, _ string, ids []string) error {
	f.printIDs = ids
	return f.err
}

func (f *ptFakeSvc) Export(_ context.Context, _ domain.Actor, _, format string) (service.ExportFile, error) {
	f.exportF = format
	if f.err != nil {
		return service.ExportFile{}, f.err
	}
	return service.ExportFile{
		Filename: "Розыгрыш-participants.csv", ContentType: "text/csv; charset=utf-8",
		WriteTo: func(w io.Writer) error { _, err := io.WriteString(w, "a;b"); return err },
	}, nil
}

func (f *ptFakeSvc) Import(_ context.Context, _ domain.Actor, in service.ImportInput) (service.ImportResult, error) {
	b, _ := io.ReadAll(in.File)
	f.impBody, in.File = string(b), nil
	f.impIn = in
	return f.impRes, f.err
}

func ptRow() domain.Participant {
	return domain.Participant{
		ID: testRow, ProjectID: testProject, Number: 5, Name: "Azam", Phone: "+998", Version: 3,
		UpdatedAt: time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC),
	}
}

func ptDo(t *testing.T, call func(w http.ResponseWriter, r *http.Request), method, target, ctype string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, target, body)
	if ctype != "" {
		r.Header.Set("Content-Type", ctype)
	}
	r = r.WithContext(WithActor(r.Context(), domain.Actor{UserID: testUser}))
	w := httptest.NewRecorder()
	call(w, r)
	return w
}

func ptJSON(s string) io.Reader { return strings.NewReader(s) }

func ptErrCode(t *testing.T, w *httptest.ResponseRecorder) (string, map[string]any) {
	t.Helper()
	var env struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("not an error envelope: %q", w.Body.String())
	}
	return env.Error.Code, env.Error.Details
}

func ptID(s string) gen.ProjectId { return participantsParseUUID(s) }

func TestListParticipants(t *testing.T) {
	svc := &ptFakeSvc{listRes: service.ParticipantList{Items: []domain.Participant{ptRow()}, Rev: 42, ETag: `"abc"`}}
	h := NewParticipantsHandler(svc)
	q, inm := "az", `"old"`
	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) {
		h.ListParticipants(w, r, ptID(testProject), gen.ListParticipantsParams{Q: &q, IfNoneMatch: &inm})
	}, http.MethodGet, "/x", "", nil)

	if w.Code != 200 || w.Header().Get("ETag") != `"abc"` {
		t.Fatalf("status %d etag %q", w.Code, w.Header().Get("ETag"))
	}
	if svc.listIn.ProjectID != testProject || svc.listIn.Query != "az" || svc.listIn.IfNoneMatch != `"old"` {
		t.Fatalf("input = %+v", svc.listIn)
	}
	var got gen.ParticipantList
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Rev != 42 || len(got.Items) != 1 || got.Items[0].Id.String() != testRow || got.Items[0].Number != 5 || got.Items[0].Version != 3 {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestListParticipantsNotModified(t *testing.T) {
	svc := &ptFakeSvc{listRes: service.ParticipantList{ETag: `"abc"`, NotModified: true}}
	h := NewParticipantsHandler(svc)
	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) {
		h.ListParticipants(w, r, ptID(testProject), gen.ListParticipantsParams{})
	}, http.MethodGet, "/x", "", nil)
	if w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("ETag") != `"abc"` {
		t.Fatalf("status %d body %q etag %q", w.Code, w.Body.String(), w.Header().Get("ETag"))
	}
}

func TestCreateParticipantsShapes(t *testing.T) {
	svc := &ptFakeSvc{}
	h := NewParticipantsHandler(svc)
	call := func(body string) *httptest.ResponseRecorder {
		svc.addIn = service.AddInput{}
		return ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.CreateParticipants(w, r, ptID(testProject)) },
			http.MethodPost, "/x", "application/json", ptJSON(body))
	}

	if w := call(`{"count":10}`); w.Code != 201 || svc.addIn.Count != 10 || svc.addIn.HasItems {
		t.Fatalf("count: %d %+v", w.Code, svc.addIn)
	}
	w := call(`{"items":[{"name":"A","phone":"1"},{"name":"B"},{}]}`)
	if w.Code != 201 || !svc.addIn.HasItems || len(svc.addIn.Items) != 3 || svc.addIn.Items[0].Phone != "1" || svc.addIn.Items[1].Phone != "" {
		t.Fatalf("items: %d %+v", w.Code, svc.addIn)
	}
	var got gen.ParticipantItems
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || len(got.Items) != 1 {
		t.Fatalf("body = %s", w.Body.String())
	}
	if w := call(`{"items":[]}`); !svc.addIn.HasItems || len(svc.addIn.Items) != 0 || w.Code != 201 {
		t.Fatalf("empty items must reach the service as an explicit list: %+v", svc.addIn)
	}
	for _, bad := range []string{`{}`, `{"count":0}`, `{"count":"x"}`, `{"count":1,"extra":true}`, ``, `not json`} {
		svc.err = nil
		w := call(bad)
		// {} and the empty list are rejected by the service; malformed JSON and count=0 by the handler.
		if bad == `{}` {
			continue
		}
		if code, _ := ptErrCode(t, w); w.Code != 400 || code != "VALIDATION" {
			t.Errorf("%q: status %d code %q", bad, w.Code, code)
		}
	}
}

func TestUpdateParticipant(t *testing.T) {
	svc := &ptFakeSvc{}
	h := NewParticipantsHandler(svc)
	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) {
		h.UpdateParticipant(w, r, participantsParseUUID(testRow))
	}, http.MethodPatch, "/x", "application/json", ptJSON(`{"name":"N","version":3}`))
	if w.Code != 200 || svc.updIn.ID != testRow || svc.updIn.Name == nil || *svc.updIn.Name != "N" || svc.updIn.Phone != nil || svc.updIn.Version != 3 {
		t.Fatalf("status %d in %+v", w.Code, svc.updIn)
	}
	var got gen.ParticipantResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Item.Name != "Azam" {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestUpdateParticipantConflictsUseDTOShape(t *testing.T) {
	svc := &ptFakeSvc{err: domain.NewVersionConflict(ptRow())}
	h := NewParticipantsHandler(svc)
	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) {
		h.UpdateParticipant(w, r, participantsParseUUID(testRow))
	}, http.MethodPatch, "/x", "application/json", ptJSON(`{"name":"N","version":1}`))
	code, details := ptErrCode(t, w)
	if w.Code != 409 || code != "VERSION_CONFLICT" {
		t.Fatalf("status %d code %s", w.Code, code)
	}
	cur, ok := details["current"].(map[string]any)
	if !ok || cur["id"] != testRow || cur["projectId"] != testProject || cur["version"] != float64(3) || cur["name"] != "Azam" {
		t.Fatalf("details.current = %v", details["current"])
	}

	svc.err = domain.NewRowLocked(testUser)
	w = ptDo(t, func(w http.ResponseWriter, r *http.Request) {
		h.UpdateParticipant(w, r, participantsParseUUID(testRow))
	}, http.MethodPatch, "/x", "application/json", ptJSON(`{"name":"N","version":1}`))
	code, details = ptErrCode(t, w)
	if w.Code != 409 || code != "ROW_LOCKED" || details["by"] != testUser {
		t.Fatalf("locked: %d %s %v", w.Code, code, details)
	}
}

func TestBulkEndpoints(t *testing.T) {
	svc := &ptFakeSvc{}
	h := NewParticipantsHandler(svc)
	ids := `{"ids":["` + testRow + `","` + testUser + `"]}`

	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.DeleteParticipants(w, r, ptID(testProject)) }, http.MethodPost, "/x", "application/json", ptJSON(ids))
	if w.Code != 200 || len(svc.delIDs) != 2 || svc.delIDs[0] != testRow || !strings.Contains(w.Body.String(), `"deleted":2`) {
		t.Fatalf("delete: %d %s %v", w.Code, w.Body.String(), svc.delIDs)
	}
	w = ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.LogPrinted(w, r, ptID(testProject)) }, http.MethodPost, "/x", "application/json", ptJSON(ids))
	if w.Code != 204 || w.Body.Len() != 0 || len(svc.printIDs) != 2 {
		t.Fatalf("printed: %d %q", w.Code, w.Body.String())
	}
	w = ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.ClearParticipants(w, r, ptID(testProject)) }, http.MethodPost, "/x", "application/json", ptJSON(`{"confirmTitle":"Raffle"}`))
	if w.Code != 200 || svc.clearT != "Raffle" || !strings.Contains(w.Body.String(), `"deleted":7`) {
		t.Fatalf("clear: %d %s", w.Code, w.Body.String())
	}
	// invalid uuid in the body is a validation error, not a 500
	w = ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.DeleteParticipants(w, r, ptID(testProject)) }, http.MethodPost, "/x", "application/json", ptJSON(`{"ids":["nope"]}`))
	if code, _ := ptErrCode(t, w); w.Code != 400 || code != "VALIDATION" {
		t.Fatalf("bad id: %d %s", w.Code, w.Body.String())
	}
}

func TestErrorsMapToStatuses(t *testing.T) {
	cases := map[error]int{
		domain.ErrForbidden:       403,
		domain.ErrNotFound:        404,
		domain.ErrProjectFinished: 409,
		domain.ErrTooLarge:        413,
	}
	for err, want := range cases {
		h := NewParticipantsHandler(&ptFakeSvc{err: err})
		w := ptDo(t, func(w http.ResponseWriter, r *http.Request) {
			h.ClearParticipants(w, r, ptID(testProject))
		}, http.MethodPost, "/x", "application/json", ptJSON(`{"confirmTitle":"x"}`))
		if w.Code != want {
			t.Errorf("%v: status %d, want %d", err, w.Code, want)
		}
	}
}

func TestUnauthenticatedRequest(t *testing.T) {
	h := NewParticipantsHandler(&ptFakeSvc{})
	w := httptest.NewRecorder()
	h.ListParticipants(w, httptest.NewRequest(http.MethodGet, "/x", nil), ptID(testProject), gen.ListParticipantsParams{})
	if w.Code != 401 {
		t.Fatalf("status %d", w.Code)
	}
}

func TestExportHeaders(t *testing.T) {
	svc := &ptFakeSvc{}
	h := NewParticipantsHandler(svc)
	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.ExportParticipantsCsv(w, r, ptID(testProject)) }, http.MethodGet, "/x", "", nil)
	if w.Code != 200 || svc.exportF != service.FormatCSV || w.Body.String() != "a;b" {
		t.Fatalf("status %d fmt %s body %q", w.Code, svc.exportF, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Fatalf("content-type %q", ct)
	}
	disp, params, err := mime.ParseMediaType(w.Header().Get("Content-Disposition"))
	if err != nil || disp != "attachment" || params["filename"] != "Розыгрыш-participants.csv" {
		t.Fatalf("disposition %q -> %v %v %v", w.Header().Get("Content-Disposition"), disp, params, err)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers = %v", w.Header())
	}

	ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.ExportParticipantsXlsx(w, r, ptID(testProject)) }, http.MethodGet, "/x", "", nil)
	if svc.exportF != service.FormatXLSX {
		t.Fatalf("xlsx handler used %q", svc.exportF)
	}

	svc.err = domain.ErrForbidden
	w = ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.ExportParticipantsCsv(w, r, ptID(testProject)) }, http.MethodGet, "/x", "", nil)
	if w.Code != 403 || strings.Contains(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("denied export: %d %v", w.Code, w.Header())
	}
}

func ptMultipart(t *testing.T, mode string, file string, withFile bool) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if mode != "" {
		_ = mw.WriteField("mode", mode)
	}
	if withFile {
		fw, _ := mw.CreateFormFile("file", "people.csv")
		_, _ = io.WriteString(fw, file)
	}
	_ = mw.Close()
	return &buf, mw.FormDataContentType()
}

func TestImportParticipants(t *testing.T) {
	svc := &ptFakeSvc{impRes: service.ImportResult{
		DryRun: true, Mode: "append", Total: 3, Valid: 2,
		Errors: []service.ImportRowError{{Row: 4, Field: "name", Code: "too_long", Message: "m"}},
	}}
	h := NewParticipantsHandler(svc)
	body, ct := ptMultipart(t, "append", "name\nA\n", true)
	dry := true
	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) {
		h.ImportParticipants(w, r, ptID(testProject), gen.ImportParticipantsParams{DryRun: &dry})
	}, http.MethodPost, "/x", ct, body)

	if w.Code != 200 || svc.impBody != "name\nA\n" || svc.impIn.Mode != "append" || !svc.impIn.DryRun || svc.impIn.ProjectID != testProject {
		t.Fatalf("status %d in %+v body %q", w.Code, svc.impIn, svc.impBody)
	}
	var got gen.ImportResult
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.DryRun || got.Total != 3 || got.Valid != 2 || got.Mode != gen.ImportResultModeAppend ||
		len(got.Errors) != 1 || got.Errors[0].Row != 4 || got.Errors[0].Field != gen.Name {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestImportParticipantsRejections(t *testing.T) {
	svc := &ptFakeSvc{}
	h := NewParticipantsHandler(svc)
	call := func(body io.Reader, ct string) *httptest.ResponseRecorder {
		return ptDo(t, func(w http.ResponseWriter, r *http.Request) {
			h.ImportParticipants(w, r, ptID(testProject), gen.ImportParticipantsParams{})
		}, http.MethodPost, "/x", ct, body)
	}

	if w := call(ptJSON(`{}`), "application/json"); w.Code != 400 {
		t.Errorf("not multipart: %d", w.Code)
	}
	b, ct := ptMultipart(t, "append", "", false)
	if w := call(b, ct); w.Code != 400 {
		t.Errorf("missing file: %d", w.Code)
	}

	big := strings.Repeat("x", service.MaxImportBytes+1)
	b, ct = ptMultipart(t, "append", big, true)
	w := call(b, ct)
	if code, _ := ptErrCode(t, w); w.Code != 413 || code != "TOO_LARGE" {
		t.Errorf("oversized file: %d %s", w.Code, w.Body.String())
	}

	// a body far beyond the limit is cut off by MaxBytesReader
	b, ct = ptMultipart(t, "append", strings.Repeat("x", service.MaxImportBytes+importBodyOverhead+10), true)
	if w := call(b, ct); w.Code != 413 {
		t.Errorf("huge body: %d", w.Code)
	}
	if svc.impIn.File != nil || svc.impBody != "" {
		t.Error("rejected uploads must not reach the service")
	}

	svc.err = domain.ErrUnsupportedMedia
	b, ct = ptMultipart(t, "append", "x", true)
	if w := call(b, ct); w.Code != 415 {
		t.Errorf("unsupported: %d", w.Code)
	}
}

func TestAuditHandler(t *testing.T) {
	at := time.Date(2026, 11, 8, 9, 0, 0, 0, time.UTC)
	svc := &ptFakeAudit{page: service.AuditPage{
		Items: []domain.AuditEntry{
			{ID: 9, At: at, ActorID: testUser, ActorLogin: "adm", Action: "tickets.print", ProjectID: testProject, Meta: map[string]any{"count": 2}, IP: "203.0.113.1"},
			{ID: 8, At: at, Action: "system.job"},
		},
		Next: 8,
	}}
	h := NewAuditHandler(svc)
	limit, before := 2, int64(50)
	proj, actor := ptID(testProject), ptID(testUser)
	w := ptDo(t, func(w http.ResponseWriter, r *http.Request) {
		h.ListAudit(w, r, gen.ListAuditParams{Limit: &limit, Before: &before, ProjectId: &proj, Actor: &actor})
	}, http.MethodGet, "/x", "", nil)
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if svc.q.Limit != 2 || svc.q.Before != 50 || svc.q.ProjectID != testProject || svc.q.ActorID != testUser {
		t.Fatalf("query = %+v", svc.q)
	}
	var got gen.AuditPage
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Next == nil || *got.Next != 8 || len(got.Items) != 2 {
		t.Fatalf("body = %s", w.Body.String())
	}
	e0, e1 := got.Items[0], got.Items[1]
	if e0.ActorId == nil || e0.ActorId.String() != testUser || e0.Ip == nil || *e0.Ip != "203.0.113.1" || e0.Meta["count"] != float64(2) {
		t.Fatalf("entry 0 = %+v", e0)
	}
	if e1.ActorId != nil || e1.ProjectId != nil || e1.Ip != nil || e1.Meta == nil {
		t.Fatalf("entry 1 = %+v", e1)
	}
	if !strings.Contains(w.Body.String(), `"meta":{}`) {
		t.Fatalf("meta must serialize as an object: %s", w.Body.String())
	}

	// last page: next is null
	svc.page.Next = 0
	w = ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.ListAudit(w, r, gen.ListAuditParams{}) }, http.MethodGet, "/x", "", nil)
	if !strings.Contains(w.Body.String(), `"next":null`) {
		t.Fatalf("body = %s", w.Body.String())
	}

	svc.err = domain.ErrForbidden
	w = ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.ListAudit(w, r, gen.ListAuditParams{}) }, http.MethodGet, "/x", "", nil)
	if w.Code != 403 {
		t.Fatalf("status %d", w.Code)
	}
	zero := 0
	svc.err = nil
	ptDo(t, func(w http.ResponseWriter, r *http.Request) { h.ListAudit(w, r, gen.ListAuditParams{Limit: &zero}) }, http.MethodGet, "/x", "", nil)
	if svc.q.Limit >= 0 {
		t.Fatalf("explicit limit=0 must not select the default, got %d", svc.q.Limit)
	}
}

type ptFakeAudit struct {
	q    service.AuditQuery
	page service.AuditPage
	err  error
}

func (f *ptFakeAudit) List(_ context.Context, _ domain.Actor, q service.AuditQuery) (service.AuditPage, error) {
	f.q = q
	return f.page, f.err
}
