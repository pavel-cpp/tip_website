package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func ptr[T any](v T) *T { return &v }

func mustCode(t *testing.T, err error, want domain.Code) {
	t.Helper()
	if got := domain.CodeOf(err); got != want {
		t.Fatalf("code = %q (%v), want %q", got, err, want)
	}
}

func TestListPermissionsAndVisibility(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	f.seed(projActive, 2)
	f.seed(projFinished, 1)

	t.Run("no project.view hides everything", func(t *testing.T) {
		_, err := f.svc.List(ctx, actorWith("u", domain.PermParticipantView), ListInput{ProjectID: projActive})
		mustCode(t, err, domain.CodeNotFound)
	})
	t.Run("participant.view required", func(t *testing.T) {
		_, err := f.svc.List(ctx, actorWith("u", domain.PermProjectView), ListInput{ProjectID: projActive})
		mustCode(t, err, domain.CodeForbidden)
	})
	t.Run("finished project hidden without view_finished", func(t *testing.T) {
		a := actorWith("u", domain.PermProjectView, domain.PermParticipantView)
		_, err := f.svc.List(ctx, a, ListInput{ProjectID: projFinished})
		mustCode(t, err, domain.CodeNotFound)
	})
	t.Run("finished project readable with view_finished", func(t *testing.T) {
		res, err := f.svc.List(ctx, operator(), ListInput{ProjectID: projFinished})
		if err != nil || len(res.Items) != 1 {
			t.Fatalf("got %+v, %v", res, err)
		}
	})
	t.Run("unknown project", func(t *testing.T) {
		_, err := f.svc.List(ctx, operator(), ListInput{ProjectID: "nope"})
		mustCode(t, err, domain.CodeNotFound)
	})
	t.Run("query too long", func(t *testing.T) {
		_, err := f.svc.List(ctx, operator(), ListInput{ProjectID: projActive, Query: strings.Repeat("x", 201)})
		mustCode(t, err, domain.CodeValidation)
	})
}

func TestListETagAndNotModified(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	rows := f.seed(projActive, 3)

	first, err := f.svc.List(ctx, operator(), ListInput{ProjectID: projActive})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 3 || first.ETag == "" || !strings.HasPrefix(first.ETag, `"`) || first.Rev == 0 {
		t.Fatalf("first = %+v", first)
	}
	listsBefore := f.repo.lists

	for _, header := range []string{first.ETag, "W/" + first.ETag, `"other", ` + first.ETag, "*"} {
		res, err := f.svc.List(ctx, operator(), ListInput{ProjectID: projActive, IfNoneMatch: header})
		if err != nil || !res.NotModified || res.Items != nil || res.ETag != first.ETag {
			t.Fatalf("If-None-Match %q: %+v, %v", header, res, err)
		}
	}
	if f.repo.lists != listsBefore {
		t.Fatal("a 304 must not read the rows")
	}

	// an edit changes the ETag
	next, _ := rows[0].Edited("New", "", rows[0].Version, "", testNow)
	if _, err := f.repo.UpdateIfVersion(ctx, next); err != nil {
		t.Fatal(err)
	}
	after, _ := f.svc.List(ctx, operator(), ListInput{ProjectID: projActive, IfNoneMatch: first.ETag})
	if after.NotModified || after.ETag == first.ETag {
		t.Fatalf("etag did not change after an edit: %+v", after)
	}
	// a delete changes it too, and the filter is part of it
	if _, err := f.repo.DeleteByIDs(ctx, projActive, []string{rows[1].ID}); err != nil {
		t.Fatal(err)
	}
	afterDelete, _ := f.svc.List(ctx, operator(), ListInput{ProjectID: projActive})
	filtered, _ := f.svc.List(ctx, operator(), ListInput{ProjectID: projActive, Query: "new"})
	if afterDelete.ETag == after.ETag || filtered.ETag == afterDelete.ETag || len(filtered.Items) != 1 {
		t.Fatalf("etags: %s %s %s", after.ETag, afterDelete.ETag, filtered.ETag)
	}
}

func TestAddByCount(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	rows, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, Count: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[0].Number != 1 || rows[2].Number != 3 || rows[0].UpdatedBy != "user-1" {
		t.Fatalf("rows = %+v", rows)
	}
	if f.tx.calls != 1 {
		t.Fatalf("tx calls = %d", f.tx.calls)
	}
	if len(f.notify.events) != 1 || f.notify.events[0].ev.EventType() != domain.EventRowsUpsert || f.notify.events[0].project != projActive {
		t.Fatalf("events = %+v", f.notify.events)
	}
}

func TestAddByItemsTrimsAndValidates(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	rows, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, HasItems: true, Items: []ParticipantInput{
		{Name: "  Azam  ", Phone: " +998 "}, {Name: "Ali"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Name != "Azam" || rows[0].Phone != "+998" || rows[1].Phone != "" {
		t.Fatalf("rows = %+v", rows)
	}

	_, err = f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, HasItems: true, Items: []ParticipantInput{
		{Name: "ok"}, {Name: strings.Repeat("я", 201)}, {Phone: strings.Repeat("1", 41)},
	}})
	mustCode(t, err, domain.CodeValidation)
	var ve *domain.ValidationError
	if !errors.As(err, &ve) || len(ve.Fields) != 2 || ve.Fields[0].Field != "items[1].name" || ve.Fields[1].Field != "items[2].phone" {
		t.Fatalf("fields = %+v", ve)
	}
	if got, _ := f.repo.Count(ctx, projActive); got != 2 {
		t.Fatalf("invalid batch must not be stored partially, rows = %d", got)
	}
}

func TestAddRejectsBadShapes(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	cases := map[string]AddInput{
		"neither":     {ProjectID: projActive},
		"both":        {ProjectID: projActive, Count: 1, HasItems: true, Items: []ParticipantInput{{}}},
		"negative":    {ProjectID: projActive, Count: -1},
		"too many":    {ProjectID: projActive, Count: domain.MaxAddRows + 1},
		"empty items": {ProjectID: projActive, HasItems: true},
		"huge items":  {ProjectID: projActive, HasItems: true, Items: make([]ParticipantInput, domain.MaxAddRows+1)},
	}
	for name, in := range cases {
		if _, err := f.svc.Add(ctx, operator(), in); domain.CodeOf(err) != domain.CodeValidation {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if _, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, Count: domain.MaxAddRows}); err != nil {
		t.Fatalf("5000 must be accepted: %v", err)
	}
}

func TestAddGuards(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	_, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projFinished, Count: 1})
	mustCode(t, err, domain.CodeProjectFinished)
	_, err = f.svc.Add(ctx, actorWith("u", domain.PermProjectView, domain.PermParticipantView), AddInput{ProjectID: projActive, Count: 1})
	mustCode(t, err, domain.CodeForbidden)
	// a user who cannot see finished projects gets 404, not 409
	a := actorWith("u", domain.PermProjectView, domain.PermParticipantEdit)
	_, err = f.svc.Add(ctx, a, AddInput{ProjectID: projFinished, Count: 1})
	mustCode(t, err, domain.CodeNotFound)
}

func TestAddEnforcesProjectRowCap(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	for range MaxProjectRows / domain.MaxAddRows {
		if _, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, Count: domain.MaxAddRows}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, Count: 1})
	mustCode(t, err, domain.CodeValidation)
}

func TestAddPublishesInChunks(t *testing.T) {
	f := newFixture()
	if _, err := f.svc.Add(context.Background(), operator(), AddInput{ProjectID: projActive, Count: 1200}); err != nil {
		t.Fatal(err)
	}
	if len(f.notify.events) != 3 {
		t.Fatalf("events = %d, want 3 chunks (500+500+200)", len(f.notify.events))
	}
}

func TestUpdateHappyPath(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	row := f.seed(projActive, 1)[0]

	saved, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr("  Azam "), Version: row.Version})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Name != "Azam" || saved.Version != 2 || saved.UpdatedBy != "user-1" || !saved.UpdatedAt.Equal(testNow) {
		t.Fatalf("saved = %+v", saved)
	}
	if len(f.notify.events) != 1 {
		t.Fatalf("events = %+v", f.notify.events)
	}
	ev := f.notify.events[0].ev.(domain.RowsUpsertedEvent)
	if ev.Items[0].ID != row.ID || ev.Items[0].Version != 2 {
		t.Fatalf("event = %+v", ev)
	}

	// a nil field keeps the stored value
	again, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Phone: ptr("+998"), Version: 2})
	if err != nil || again.Name != "Azam" || again.Phone != "+998" || again.Version != 3 {
		t.Fatalf("again = %+v, %v", again, err)
	}
}

func TestUpdateRejections(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	row := f.seed(projActive, 1)[0]
	fin := f.seed(projFinished, 1)[0]

	_, err := f.svc.Update(ctx, actorWith("u", domain.PermProjectView, domain.PermParticipantView), UpdateInput{ID: row.ID, Name: ptr("x"), Version: 1})
	mustCode(t, err, domain.CodeForbidden)
	_, err = f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Version: 1})
	mustCode(t, err, domain.CodeValidation)
	_, err = f.svc.Update(ctx, operator(), UpdateInput{ID: "missing", Name: ptr("x"), Version: 1})
	mustCode(t, err, domain.CodeNotFound)
	_, err = f.svc.Update(ctx, operator(), UpdateInput{ID: fin.ID, Name: ptr("x"), Version: 1})
	mustCode(t, err, domain.CodeProjectFinished)
	_, err = f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr(strings.Repeat("a", 201)), Version: 1})
	mustCode(t, err, domain.CodeValidation)
	if len(f.notify.events) != 0 {
		t.Fatalf("rejected edits must not publish: %+v", f.notify.events)
	}
}

func TestUpdateRowLocked(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	row := f.seed(projActive, 1)[0]

	f.locks.locks[row.ID] = domain.NewRowLock(row.ID, "someone-else", testNow)
	_, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr("x"), Version: 1})
	mustCode(t, err, domain.CodeRowLocked)
	var de *domain.Error
	if !errors.As(err, &de) || de.Details["by"] != "someone-else" {
		t.Fatalf("lock owner missing from details: %+v", err)
	}

	// own lock and an expired foreign lock do not block
	f.locks.locks[row.ID] = domain.NewRowLock(row.ID, "user-1", testNow)
	if _, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr("x"), Version: 1}); err != nil {
		t.Fatalf("own lock: %v", err)
	}
	f.locks.locks[row.ID] = domain.NewRowLock(row.ID, "someone-else", testNow.Add(-2*domain.LockTTL))
	if _, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr("y"), Version: 2}); err != nil {
		t.Fatalf("expired lock: %v", err)
	}
}

func TestUpdateVersionConflictCarriesCurrentRow(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	row := f.seed(projActive, 1)[0]
	if _, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr("first"), Version: 1}); err != nil {
		t.Fatal(err)
	}
	f.notify.events = nil

	_, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr("stale"), Version: 1})
	mustCode(t, err, domain.CodeVersionConflict)
	var de *domain.Error
	if !errors.As(err, &de) {
		t.Fatalf("not a domain error: %v", err)
	}
	cur, ok := de.Details["current"].(domain.Participant)
	if !ok || cur.Name != "first" || cur.Version != 2 {
		t.Fatalf("details.current = %+v", de.Details["current"])
	}
	if len(f.notify.events) != 0 {
		t.Fatal("a conflict must not publish")
	}
}

func TestUpdateRaceLostInRepoAttachesLatestRow(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	row := f.seed(projActive, 1)[0]
	// The row is current when read, but the repository reports a conflict (someone won the race).
	f.repo.updateErr = domain.ErrVersionConflict

	_, err := f.svc.Update(ctx, operator(), UpdateInput{ID: row.ID, Name: ptr("x"), Version: 1})
	mustCode(t, err, domain.CodeVersionConflict)
	var de *domain.Error
	if !errors.As(err, &de) {
		t.Fatal("not a domain error")
	}
	if _, ok := de.Details["current"].(domain.Participant); !ok {
		t.Fatalf("details.current missing: %+v", de.Details)
	}
}

func TestUpdateRepoFailureIsWrappedNotLeaked(t *testing.T) {
	f := newFixture()
	row := f.seed(projActive, 1)[0]
	f.repo.updateErr = errors.New("connection reset")
	_, err := f.svc.Update(context.Background(), operator(), UpdateInput{ID: row.ID, Name: ptr("x"), Version: 1})
	mustCode(t, err, domain.CodeInternal)
}

func TestDelete(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	rows := f.seed(projActive, 4)

	n, err := f.svc.Delete(ctx, operator(), projActive, []string{rows[0].ID, rows[0].ID, rows[1].ID, "ghost"})
	if err != nil || n != 2 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if len(f.audit.calls) != 1 || f.audit.calls[0].action != domain.ActionParticipantsDelete || f.audit.calls[0].meta["count"] != 2 {
		t.Fatalf("audit = %+v", f.audit.calls)
	}
	if _, hasIDs := f.audit.calls[0].meta["ids"]; hasIDs {
		t.Fatal("delete audit must hold the count only")
	}
	ev := f.notify.events[len(f.notify.events)-1].ev.(domain.RowsDeletedEvent)
	if len(ev.IDs) != 2 {
		t.Fatalf("event = %+v", ev)
	}

	f.notify.events = nil
	n, err = f.svc.Delete(ctx, operator(), projActive, []string{"ghost"})
	if err != nil || n != 0 || len(f.notify.events) != 0 {
		t.Fatalf("nothing deleted: n=%d err=%v events=%v", n, err, f.notify.events)
	}

	_, err = f.svc.Delete(ctx, operator(), projActive, nil)
	mustCode(t, err, domain.CodeValidation)
	_, err = f.svc.Delete(ctx, operator(), projFinished, []string{"x"})
	mustCode(t, err, domain.CodeProjectFinished)
	_, err = f.svc.Delete(ctx, actorWith("u", domain.PermProjectView, domain.PermParticipantEdit), projActive, []string{"x"})
	mustCode(t, err, domain.CodeForbidden)
}

func TestDeleteAuditFailureFailsTheRequest(t *testing.T) {
	f := newFixture()
	rows := f.seed(projActive, 1)
	f.audit.err = errors.New("audit down")
	if _, err := f.svc.Delete(context.Background(), operator(), projActive, []string{rows[0].ID}); err == nil {
		t.Fatal("expected the audit failure to fail the request (and roll back the Tx)")
	}
	if len(f.notify.events) != 0 {
		t.Fatal("must not publish when the transaction failed")
	}
}

func TestClear(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	f.seed(projActive, 3)

	_, err := f.svc.Clear(ctx, operator(), projActive, "wrong")
	mustCode(t, err, domain.CodeValidation)
	if got, _ := f.repo.Count(ctx, projActive); got != 3 {
		t.Fatalf("wrong title must not clear, rows = %d", got)
	}

	n, err := f.svc.Clear(ctx, operator(), projActive, "  Raffle ")
	if err != nil || n != 3 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if len(f.audit.calls) != 1 || f.audit.calls[0].action != domain.ActionParticipantsClear || f.audit.calls[0].meta["count"] != 3 {
		t.Fatalf("audit = %+v", f.audit.calls)
	}
	if _, ok := f.notify.events[len(f.notify.events)-1].ev.(domain.RowsDeletedEvent); !ok {
		t.Fatalf("events = %+v", f.notify.events)
	}

	_, err = f.svc.Clear(ctx, actorWith("u", domain.PermProjectView, domain.PermParticipantDelete), projActive, "Raffle")
	mustCode(t, err, domain.CodeForbidden)
	_, err = f.svc.Clear(ctx, operator(), projFinished, "Old")
	mustCode(t, err, domain.CodeProjectFinished)
}

func TestLogPrinted(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	ids := []string{"a", "b", "a", "c"}
	if err := f.svc.LogPrinted(ctx, operator(), projActive, ids); err != nil {
		t.Fatal(err)
	}
	c := f.audit.calls[0]
	if c.action != domain.ActionTicketsPrint || c.project != projActive || c.meta["count"] != 3 {
		t.Fatalf("audit = %+v", c)
	}
	if got := c.meta["ids"].([]string); fmt.Sprint(got) != "[a b c]" {
		t.Fatalf("ids = %v", got)
	}

	// large print jobs store a bounded id list and the full count
	big := make([]string, 1500)
	for i := range big {
		big[i] = fmt.Sprintf("id-%d", i)
	}
	if err := f.svc.LogPrinted(ctx, operator(), projActive, big); err != nil {
		t.Fatal(err)
	}
	c = f.audit.calls[1]
	if c.meta["count"] != 1500 || len(c.meta["ids"].([]string)) != maxAuditIDs || c.meta["truncated"] != true {
		t.Fatalf("big audit = count %v, ids %d", c.meta["count"], len(c.meta["ids"].([]string)))
	}

	// a finished project can still be printed
	if err := f.svc.LogPrinted(ctx, operator(), projFinished, []string{"x"}); err != nil {
		t.Fatalf("finished: %v", err)
	}
	mustCode(t, f.svc.LogPrinted(ctx, operator(), projActive, nil), domain.CodeValidation)
	mustCode(t, f.svc.LogPrinted(ctx, actorWith("u", domain.PermProjectView, domain.PermParticipantView), projActive, ids), domain.CodeForbidden)
}

func TestExport(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	f.seed(projFinished, 2)

	file, err := f.svc.Export(ctx, operator(), projFinished, FormatXLSX)
	if err != nil {
		t.Fatal(err)
	}
	if file.Filename != "Old-participants.xlsx" || !strings.Contains(file.ContentType, "spreadsheetml.sheet") {
		t.Fatalf("file = %+v", file)
	}
	var buf bytes.Buffer
	if err := file.WriteTo(&buf); err != nil || buf.String() != "file:xlsx" || len(f.sheets.wrote) != 2 {
		t.Fatalf("buf=%q wrote=%d err=%v", buf.String(), len(f.sheets.wrote), err)
	}
	csv, err := f.svc.Export(ctx, operator(), projActive, FormatCSV)
	if err != nil || csv.Filename != "Raffle-participants.csv" || csv.ContentType != "text/csv; charset=utf-8" {
		t.Fatalf("csv = %+v, %v", csv, err)
	}

	_, err = f.svc.Export(ctx, operator(), projActive, "pdf")
	mustCode(t, err, domain.CodeValidation)
	_, err = f.svc.Export(ctx, actorWith("u", domain.PermProjectView, domain.PermParticipantView), projActive, FormatCSV)
	mustCode(t, err, domain.CodeForbidden)
	_, err = f.svc.Export(ctx, actorWith("u", domain.PermParticipantExport), projActive, FormatCSV)
	mustCode(t, err, domain.CodeNotFound)
}

func TestExportBaseName(t *testing.T) {
	cases := map[string]string{
		"Tashkent City - BMW":     "Tashkent_City_BMW-participants",
		"Розыгрыш / 2026":         "Розыгрыш_2026-participants",
		"  ../../etc/passwd  ":    "etc_passwd-participants",
		"***":                     "participants",
		"":                        "participants",
		`a"b;c` + "\r\nX-Evil: 1": "a_b_c_X_Evil_1-participants",
		strings.Repeat("ы", 100):  strings.Repeat("ы", 60) + "-participants",
	}
	for in, want := range cases {
		if got := exportBaseName(in); got != want {
			t.Errorf("exportBaseName(%q) = %q, want %q", in, got, want)
		}
	}
}

func importIn(mode string, dry bool, body string) ImportInput {
	return ImportInput{ProjectID: projActive, Mode: mode, DryRun: dry, File: strings.NewReader(body)}
}

func TestImportDryRunReportsErrorsAndWritesNothing(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	body := "header\nAzam|+998\n" + strings.Repeat("x", 201) + "|1\nAli|" + strings.Repeat("9", 41) + "\nPetr|"
	res, err := f.svc.Import(ctx, operator(), importIn(ImportAppend, true, body))
	if err != nil {
		t.Fatal(err)
	}
	if !res.DryRun || res.Total != 4 || res.Valid != 2 || res.Imported != 0 || len(res.Errors) != 2 {
		t.Fatalf("res = %+v", res)
	}
	if res.Errors[0].Row != 3 || res.Errors[0].Field != "name" || res.Errors[0].Code != "too_long" ||
		res.Errors[1].Row != 4 || res.Errors[1].Field != "phone" {
		t.Fatalf("errors = %+v", res.Errors)
	}
	if got, _ := f.repo.Count(ctx, projActive); got != 0 {
		t.Fatalf("dry run wrote %d rows", got)
	}
	if len(f.audit.calls) != 0 || len(f.notify.events) != 0 || f.tx.calls != 0 {
		t.Fatalf("dry run must have no side effects: audit=%v events=%v tx=%d", f.audit.calls, f.notify.events, f.tx.calls)
	}
	if f.sheets.maxRowsIn != MaxImportRows {
		t.Fatalf("row limit passed to the codec = %d", f.sheets.maxRowsIn)
	}
}

func TestImportAppend(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	f.seed(projActive, 2)
	f.notify.events = nil

	res, err := f.svc.Import(ctx, operator(), importIn(ImportAppend, false, "Azam|+998\nBad"+strings.Repeat("x", 300)+"|1\nAli|2"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 3 || res.Valid != 2 || res.Imported != 2 || len(res.Errors) != 1 || res.Mode != ImportAppend {
		t.Fatalf("res = %+v", res)
	}
	rows, _ := f.repo.List(ctx, projActive, "")
	if len(rows) != 4 || rows[2].Number != 3 || rows[2].Name != "Azam" || rows[3].Number != 4 {
		t.Fatalf("rows = %+v", rows)
	}
	c := f.audit.calls[0]
	if c.action != domain.ActionParticipantsImport || c.meta["imported"] != 2 || c.meta["mode"] != ImportAppend || c.meta["deleted"] != 0 {
		t.Fatalf("audit = %+v", c)
	}
	for k, v := range c.meta {
		if s, ok := v.(string); ok && (strings.Contains(s, "Azam") || strings.Contains(s, "998")) {
			t.Fatalf("audit meta %q leaks personal data: %v", k, v)
		}
	}
	if len(f.notify.events) != 1 || f.notify.events[0].ev.EventType() != domain.EventRowsUpsert {
		t.Fatalf("events = %+v", f.notify.events)
	}
}

func TestImportReplace(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	f.seed(projActive, 3)
	f.notify.events = nil

	res, err := f.svc.Import(ctx, operator(), importIn(ImportReplace, false, "Azam|1\nAli|2"))
	if err != nil || res.Imported != 2 {
		t.Fatalf("res = %+v, %v", res, err)
	}
	rows, _ := f.repo.List(ctx, projActive, "")
	if len(rows) != 2 || rows[0].Number != 4 { // numbers are never reused
		t.Fatalf("rows = %+v", rows)
	}
	if f.audit.calls[0].meta["deleted"] != 3 {
		t.Fatalf("audit = %+v", f.audit.calls[0])
	}
	if len(f.notify.events) != 2 || f.notify.events[0].ev.EventType() != domain.EventRowsDelete || f.notify.events[1].ev.EventType() != domain.EventRowsUpsert {
		t.Fatalf("events = %+v", f.notify.events)
	}
}

func TestImportReplaceWithoutValidRowsKeepsTable(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	f.seed(projActive, 3)
	_, err := f.svc.Import(ctx, operator(), importIn(ImportReplace, false, "header\n"))
	mustCode(t, err, domain.CodeValidation)
	_, err = f.svc.Import(ctx, operator(), importIn(ImportReplace, false, strings.Repeat("x", 300)+"|1"))
	mustCode(t, err, domain.CodeValidation)
	if got, _ := f.repo.Count(ctx, projActive); got != 3 {
		t.Fatalf("table was modified: %d rows", got)
	}
	// append of an empty file is a harmless no-op
	res, err := f.svc.Import(ctx, operator(), importIn(ImportAppend, false, ""))
	if err != nil || res.Imported != 0 || len(f.audit.calls) != 0 {
		t.Fatalf("res=%+v err=%v audit=%v", res, err, f.audit.calls)
	}
}

func TestImportGuards(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	mustErr := func(in ImportInput, a domain.Actor, want domain.Code) {
		t.Helper()
		_, err := f.svc.Import(ctx, a, in)
		mustCode(t, err, want)
	}
	mustErr(importIn("merge", false, "a|b"), operator(), domain.CodeValidation)
	mustErr(importIn(ImportAppend, false, "a|b"), actorWith("u", domain.PermProjectView, domain.PermParticipantEdit), domain.CodeForbidden)
	mustErr(ImportInput{ProjectID: projFinished, Mode: ImportAppend, File: strings.NewReader("a|b")}, operator(), domain.CodeProjectFinished)
	mustErr(ImportInput{ProjectID: projFinished, Mode: ImportAppend, DryRun: true, File: strings.NewReader("a|b")}, operator(), domain.CodeProjectFinished)

	for name, readErr := range map[string]error{"too large": domain.ErrTooLarge, "unsupported": domain.ErrUnsupportedMedia} {
		f.sheets.readErr = readErr
		_, err := f.svc.Import(ctx, operator(), importIn(ImportAppend, false, "x"))
		if !errors.Is(err, readErr) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

func TestImportErrorListIsCappedButCountsAreExact(t *testing.T) {
	f := newFixture()
	var sb strings.Builder
	for range maxImportErrors + 50 {
		sb.WriteString(strings.Repeat("x", 250) + "|1\n")
	}
	res, err := f.svc.Import(context.Background(), operator(), importIn(ImportAppend, true, sb.String()))
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != maxImportErrors+50 || res.Valid != 0 || len(res.Errors) != maxImportErrors {
		t.Fatalf("total=%d valid=%d errors=%d", res.Total, res.Valid, len(res.Errors))
	}
}

func TestImportRowCap(t *testing.T) {
	f := newFixture()
	ctx := context.Background()
	if _, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, Count: 1}); err != nil {
		t.Fatal(err)
	}
	for range MaxProjectRows/domain.MaxAddRows - 1 {
		if _, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, Count: domain.MaxAddRows}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.svc.Add(ctx, operator(), AddInput{ProjectID: projActive, Count: 4000}); err != nil {
		t.Fatal(err)
	}
	// 19_001 rows exist; importing 1000 more exceeds the cap
	var sb strings.Builder
	for i := range 1000 {
		fmt.Fprintf(&sb, "n%d|\n", i)
	}
	_, err := f.svc.Import(ctx, operator(), importIn(ImportAppend, false, sb.String()))
	mustCode(t, err, domain.CodeValidation)
}

func TestImportLargeBatchIsSplitAndNumbered(t *testing.T) {
	f := newFixture()
	var sb strings.Builder
	for i := range 12_000 {
		fmt.Fprintf(&sb, "n%d|\n", i)
	}
	res, err := f.svc.Import(context.Background(), operator(), importIn(ImportAppend, false, sb.String()))
	if err != nil || res.Imported != 12_000 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	rows, _ := f.repo.List(context.Background(), projActive, "")
	if rows[11_999].Number != 12_000 {
		t.Fatalf("last number = %d", rows[11_999].Number)
	}
}
