package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Participant table limits.
const (
	// MaxProjectRows is the most rows a project's table may hold (docs/04-api.md, section 5).
	MaxProjectRows = 20_000
	// MaxImportRows is the most data rows one import file may carry.
	MaxImportRows = MaxProjectRows
	// MaxImportBytes is the largest accepted import file; the handler enforces it on the upload.
	MaxImportBytes = 10 << 20
	// MaxIDsPerRequest bounds the id lists of delete and printed requests.
	MaxIDsPerRequest = MaxProjectRows
	// maxImportErrors bounds the error list of an import response; counts stay exact.
	maxImportErrors = 1000
	// maxAuditIDs bounds the ids stored in one audit entry; the full count is always stored.
	maxAuditIDs = 1000
	// publishChunk is the number of rows per realtime event, keeping frames small.
	publishChunk = 500
)

// Export formats.
const (
	FormatXLSX = "xlsx"
	FormatCSV  = "csv"
)

// Import modes.
const (
	ImportAppend  = "append"
	ImportReplace = "replace"
)

// ParticipantsDeps are the collaborators of Participants.
type ParticipantsDeps struct {
	Repo     ParticipantRepo
	Projects ProjectReader
	Locks    ParticipantLocks
	Notify   ParticipantNotifier
	Audit    AuditRecorder
	Tx       Tx
	Clock    Clock
	Sheets   SheetCodec
}

// Participants implements the participant table use cases: listing, editing, bulk changes,
// the printing log, export and import.
type Participants struct{ d ParticipantsDeps }

// NewParticipants builds the participants service.
func NewParticipants(d ParticipantsDeps) *Participants { return &Participants{d: d} }

// visibleProject loads the project for a reader. A project the actor may not see is reported
// as not found: without project.view nothing is visible, and finished projects need
// project.view_finished.
func (s *Participants) visibleProject(ctx context.Context, a domain.Actor, id string) (domain.Project, error) {
	if !a.Can(domain.PermProjectView) {
		return domain.Project{}, domain.ErrNotFound
	}
	p, err := s.d.Projects.Get(ctx, id)
	if err != nil {
		return domain.Project{}, err
	}
	if p.IsFinished() && !a.Can(domain.PermProjectViewFinished) {
		return domain.Project{}, domain.ErrNotFound
	}
	return p, nil
}

// readableProject is visibleProject plus a permission check (403 only after the project is visible).
func (s *Participants) readableProject(ctx context.Context, a domain.Actor, id string, perm domain.Permission) (domain.Project, error) {
	p, err := s.visibleProject(ctx, a, id)
	if err != nil {
		return domain.Project{}, err
	}
	if err := a.Require(perm); err != nil {
		return domain.Project{}, err
	}
	return p, nil
}

// writableProject is readableProject plus the read-only guard for finished projects.
func (s *Participants) writableProject(ctx context.Context, a domain.Actor, id string, perm domain.Permission) (domain.Project, error) {
	p, err := s.readableProject(ctx, a, id, perm)
	if err != nil {
		return domain.Project{}, err
	}
	if err := p.EnsureWritable(); err != nil {
		return domain.Project{}, err
	}
	return p, nil
}

// publishUpserts announces rows in chunks of publishChunk.
func (s *Participants) publishUpserts(projectID string, rows []domain.Participant) {
	for len(rows) > 0 {
		n := min(publishChunk, len(rows))
		s.d.Notify.Publish(projectID, domain.RowsUpserted(rows[:n]...))
		rows = rows[n:]
	}
}

// publishDeletes announces deleted ids in chunks.
func (s *Participants) publishDeletes(projectID string, ids []string) {
	const chunk = 2000
	for len(ids) > 0 {
		n := min(chunk, len(ids))
		s.d.Notify.Publish(projectID, domain.RowsDeleted(ids[:n]...))
		ids = ids[n:]
	}
}

// ListInput selects the rows of a table.
type ListInput struct {
	ProjectID string
	// Query is the substring filter on name and phone; empty returns every row.
	Query string
	// IfNoneMatch is the raw If-None-Match header value, empty when absent.
	IfNoneMatch string
}

// MaxQueryLen bounds the list filter.
const MaxQueryLen = 200

// ParticipantList is the result of List.
type ParticipantList struct {
	Items []domain.Participant
	// Rev is a revision marker of the table that grows with writes; clients use it as a resync hint.
	Rev int64
	// ETag is the strong validator for this exact result, quoted as in the header.
	ETag string
	// NotModified is true when IfNoneMatch matched; Items is nil then.
	NotModified bool
}

// List returns the project's rows (participant.view). Finished projects are readable
// with project.view_finished.
func (s *Participants) List(ctx context.Context, a domain.Actor, in ListInput) (ParticipantList, error) {
	if _, err := s.readableProject(ctx, a, in.ProjectID, domain.PermParticipantView); err != nil {
		return ParticipantList{}, err
	}
	q := strings.TrimSpace(in.Query)
	if utf8.RuneCountInString(q) > MaxQueryLen {
		return ParticipantList{}, domain.NewValidation(domain.FieldError{Field: "q", Reason: "must be at most 200 characters"})
	}
	// The stamp is read before the rows: if a write lands in between, the client receives
	// newer rows under an older validator and simply refetches next time.
	count, versionSum, lastWrite, err := s.d.Repo.Stamp(ctx, in.ProjectID, q)
	if err != nil {
		return ParticipantList{}, fmt.Errorf("stamp participants: %w", err)
	}
	out := ParticipantList{
		Rev:  lastWrite.UnixMicro(),
		ETag: participantsETag(in.ProjectID, q, count, versionSum, lastWrite),
	}
	if participantsETagMatches(in.IfNoneMatch, out.ETag) {
		out.NotModified = true
		return out, nil
	}
	out.Items, err = s.d.Repo.List(ctx, in.ProjectID, q)
	if err != nil {
		return ParticipantList{}, fmt.Errorf("list participants: %w", err)
	}
	return out, nil
}

func participantsETag(projectID, q string, count int, versionSum int64, lastWrite time.Time) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00%d\x00%d\x00%d", projectID, q, count, versionSum, lastWrite.UnixMicro())
	return `"` + hex.EncodeToString(h.Sum(nil)[:16]) + `"`
}

// participantsETagMatches implements the weak comparison of If-None-Match for GET: "*" or any listed
// tag equal to etag, ignoring a W/ prefix.
func participantsETagMatches(header, etag string) bool {
	for _, tok := range strings.Split(header, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "*" || strings.TrimPrefix(tok, "W/") == etag {
			return true
		}
	}
	return false
}

// ParticipantInput is the editable content of a new row.
type ParticipantInput struct {
	Name  string
	Phone string
}

// AddInput describes rows to add: either Count blank rows or explicit Items, never both.
type AddInput struct {
	ProjectID string
	// Count blank rows are added when Items is nil.
	Count int
	Items []ParticipantInput
	// HasItems tells an explicit (possibly empty) items list apart from an absent one.
	HasItems bool
}

// Add appends rows (participant.edit). Numbers are allocated atomically from the project
// counter and never reused.
func (s *Participants) Add(ctx context.Context, a domain.Actor, in AddInput) ([]domain.Participant, error) {
	proj, err := s.writableProject(ctx, a, in.ProjectID, domain.PermParticipantEdit)
	if err != nil {
		return nil, err
	}
	hasCount := in.Count != 0
	switch {
	case hasCount == in.HasItems:
		return nil, domain.NewValidation(domain.FieldError{Field: "body", Reason: "exactly one of count or items is required"})
	case hasCount && (in.Count < 1 || in.Count > domain.MaxAddRows):
		return nil, domain.NewValidation(domain.FieldError{Field: "count", Reason: "must be 1-5000"})
	case in.HasItems && (len(in.Items) < 1 || len(in.Items) > domain.MaxAddRows):
		return nil, domain.NewValidation(domain.FieldError{Field: "items", Reason: "must contain 1-5000 items"})
	}

	now := s.d.Clock.Now()
	var drafts []domain.Participant
	if in.HasItems {
		if drafts, err = cleanDrafts(in.Items, now); err != nil {
			return nil, err
		}
	}
	n := in.Count
	if in.HasItems {
		n = len(drafts)
	}

	if _, _, err := domain.AllocateNumbers(proj.NextNumber, n); err != nil {
		return nil, err
	}
	var rows []domain.Participant
	// The repository re-checks that the project is still active while allocating numbers.
	err = s.d.Tx.Do(ctx, func(ctx context.Context) error {
		have, err := s.d.Repo.Count(ctx, in.ProjectID)
		if err != nil {
			return fmt.Errorf("count participants: %w", err)
		}
		if have+n > MaxProjectRows {
			return domain.NewValidation(domain.FieldError{Field: "count", Reason: fmt.Sprintf("a project holds at most %d rows", MaxProjectRows)})
		}
		if in.HasItems {
			rows, err = s.d.Repo.Add(ctx, in.ProjectID, drafts, a.UserID, now)
		} else {
			rows, err = s.d.Repo.AddEmpty(ctx, in.ProjectID, n, a.UserID, now)
		}
		if err != nil {
			return fmt.Errorf("add participants: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.publishUpserts(in.ProjectID, rows)
	return rows, nil
}

// cleanDrafts trims and validates explicit rows using the domain rules, reporting problems
// per item index.
func cleanDrafts(items []ParticipantInput, now time.Time) ([]domain.Participant, error) {
	out := make([]domain.Participant, len(items))
	var bad []domain.FieldError
	for i, it := range items {
		p, err := domain.Participant{Version: 1}.Edited(it.Name, it.Phone, 1, "", now)
		if err != nil {
			var ve *domain.ValidationError
			if errors.As(err, &ve) {
				for _, f := range ve.Fields {
					bad = append(bad, domain.FieldError{Field: fmt.Sprintf("items[%d].%s", i, f.Field), Reason: f.Reason})
				}
				continue
			}
			return nil, err
		}
		out[i] = domain.Participant{Name: p.Name, Phone: p.Phone}
	}
	if len(bad) > 0 {
		return nil, domain.NewValidation(bad...)
	}
	return out, nil
}

// UpdateInput is a cell edit. A nil field keeps its current value.
type UpdateInput struct {
	ID      string
	Name    *string
	Phone   *string
	Version int
}

// Update edits one row (participant.edit) following docs/02-architecture.md, section 3.2: the
// row must not be locked by someone else, the version must be current, and the new row is
// announced to the project's room. A stale version yields VERSION_CONFLICT carrying the
// current row in its details.
func (s *Participants) Update(ctx context.Context, a domain.Actor, in UpdateInput) (domain.Participant, error) {
	if err := a.Require(domain.PermParticipantEdit); err != nil {
		return domain.Participant{}, err
	}
	if in.Name == nil && in.Phone == nil {
		return domain.Participant{}, domain.NewValidation(domain.FieldError{Field: "body", Reason: "name or phone is required"})
	}

	var saved domain.Participant
	err := s.d.Tx.Do(ctx, func(ctx context.Context) error {
		cur, err := s.d.Repo.Get(ctx, in.ID)
		if err != nil {
			return err
		}
		if _, err := s.writableProject(ctx, a, cur.ProjectID, domain.PermParticipantEdit); err != nil {
			return err
		}
		now := s.d.Clock.Now()
		if err := s.d.Locks.EnsureFree(ctx, cur.ID, a.UserID); err != nil {
			return err
		}
		name, phone := cur.Name, cur.Phone
		if in.Name != nil {
			name = *in.Name
		}
		if in.Phone != nil {
			phone = *in.Phone
		}
		next, err := cur.Edited(name, phone, in.Version, a.UserID, now)
		if errors.Is(err, domain.ErrVersionConflict) {
			return domain.NewVersionConflict(cur)
		}
		if err != nil {
			return err
		}
		saved, err = s.d.Repo.UpdateIfVersion(ctx, next)
		if errors.Is(err, domain.ErrVersionConflict) {
			latest, getErr := s.d.Repo.Get(ctx, in.ID)
			if getErr != nil {
				return getErr // the row vanished meanwhile: not found
			}
			return domain.NewVersionConflict(latest)
		}
		if err != nil {
			return fmt.Errorf("update participant: %w", err)
		}
		return nil
	})
	if err != nil {
		return domain.Participant{}, err
	}
	s.d.Notify.Publish(saved.ProjectID, domain.RowsUpserted(saved))
	return saved, nil
}

// uniqueIDs validates and de-duplicates an id list for bulk operations.
func uniqueIDs(ids []string) ([]string, error) {
	if len(ids) < 1 || len(ids) > MaxIDsPerRequest {
		return nil, domain.NewValidation(domain.FieldError{Field: "ids", Reason: fmt.Sprintf("must contain 1-%d ids", MaxIDsPerRequest)})
	}
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

// Delete removes the given rows (participant.delete) and returns how many existed.
func (s *Participants) Delete(ctx context.Context, a domain.Actor, projectID string, ids []string) (int, error) {
	if _, err := s.writableProject(ctx, a, projectID, domain.PermParticipantDelete); err != nil {
		return 0, err
	}
	ids, err := uniqueIDs(ids)
	if err != nil {
		return 0, err
	}
	var deleted []string
	err = s.d.Tx.Do(ctx, func(ctx context.Context) error {
		var err error
		if deleted, err = s.d.Repo.DeleteByIDs(ctx, projectID, ids); err != nil {
			return fmt.Errorf("delete participants: %w", err)
		}
		return s.d.Audit.Record(ctx, a, domain.ActionParticipantsDelete, projectID, "", map[string]any{"count": len(deleted)})
	})
	if err != nil {
		return 0, err
	}
	if len(deleted) > 0 {
		s.publishDeletes(projectID, deleted)
	}
	return len(deleted), nil
}

// Clear removes every row of the project (participant.clear). confirmTitle must equal the
// project title, which guards against clearing the wrong project.
func (s *Participants) Clear(ctx context.Context, a domain.Actor, projectID, confirmTitle string) (int, error) {
	p, err := s.writableProject(ctx, a, projectID, domain.PermParticipantClear)
	if err != nil {
		return 0, err
	}
	if strings.TrimSpace(confirmTitle) != p.Title {
		return 0, domain.NewValidation(domain.FieldError{Field: "confirmTitle", Reason: "must equal the project title"})
	}
	var deleted []string
	err = s.d.Tx.Do(ctx, func(ctx context.Context) error {
		var err error
		if deleted, err = s.d.Repo.Clear(ctx, projectID); err != nil {
			return fmt.Errorf("clear participants: %w", err)
		}
		return s.d.Audit.Record(ctx, a, domain.ActionParticipantsClear, projectID, "", map[string]any{"count": len(deleted)})
	})
	if err != nil {
		return 0, err
	}
	if len(deleted) > 0 {
		s.publishDeletes(projectID, deleted)
	}
	return len(deleted), nil
}

// LogPrinted records that tickets were printed (participant.print). The audit entry holds
// the number of rows and at most maxAuditIDs of their ids; row state is not changed.
// Finished projects can still be printed.
func (s *Participants) LogPrinted(ctx context.Context, a domain.Actor, projectID string, ids []string) error {
	if _, err := s.readableProject(ctx, a, projectID, domain.PermParticipantPrint); err != nil {
		return err
	}
	ids, err := uniqueIDs(ids)
	if err != nil {
		return err
	}
	meta := map[string]any{"count": len(ids)}
	if len(ids) > maxAuditIDs {
		meta["ids"] = ids[:maxAuditIDs]
		meta["truncated"] = true
	} else {
		meta["ids"] = ids
	}
	return s.d.Tx.Do(ctx, func(ctx context.Context) error {
		return s.d.Audit.Record(ctx, a, domain.ActionTicketsPrint, projectID, "", meta)
	})
}

// ExportFile is a ready-to-stream export.
type ExportFile struct {
	Filename    string
	ContentType string
	// WriteTo encodes the table into w. Permission and project checks are already done.
	WriteTo func(w io.Writer) error
}

// Export prepares a table download in the given format (participant.export). Finished
// projects can be exported.
func (s *Participants) Export(ctx context.Context, a domain.Actor, projectID, format string) (ExportFile, error) {
	var ct, ext string
	switch format {
	case FormatXLSX:
		ct, ext = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"
	case FormatCSV:
		ct, ext = "text/csv; charset=utf-8", ".csv"
	default:
		return ExportFile{}, domain.NewValidation(domain.FieldError{Field: "format", Reason: "must be xlsx or csv"})
	}
	p, err := s.readableProject(ctx, a, projectID, domain.PermParticipantExport)
	if err != nil {
		return ExportFile{}, err
	}
	rows, err := s.d.Repo.List(ctx, projectID, "")
	if err != nil {
		return ExportFile{}, fmt.Errorf("list participants for export: %w", err)
	}
	return ExportFile{
		Filename:    exportBaseName(p.Title) + ext,
		ContentType: ct,
		WriteTo:     func(w io.Writer) error { return s.d.Sheets.Write(w, format, rows) },
	}, nil
}

// exportBaseName derives a safe file name stem from a project title: letters and digits of
// any script are kept, everything else collapses to single underscores.
func exportBaseName(title string) string {
	var b strings.Builder
	underscore := true // swallow leading separators
	for _, r := range title {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			underscore = false
		} else if !underscore {
			b.WriteByte('_')
			underscore = true
		}
		if utf8.RuneCountInString(b.String()) >= 60 {
			break
		}
	}
	name := strings.TrimRight(b.String(), "_")
	if name == "" {
		return "participants"
	}
	return name + "-participants"
}

// ImportInput describes an import request.
type ImportInput struct {
	ProjectID string
	// Mode is ImportAppend or ImportReplace.
	Mode   string
	DryRun bool
	// File is the uploaded XLSX or CSV; the caller enforces MaxImportBytes.
	File io.Reader
}

// ImportRowError is a problem with one row of the uploaded file.
type ImportRowError struct {
	// Row is the 1-based line in the file.
	Row     int
	Field   string
	Code    string
	Message string
}

// ImportResult reports an import or a dry-run preview.
type ImportResult struct {
	DryRun bool
	Mode   string
	// Total is the number of non-empty data rows found.
	Total int
	// Valid is the number of rows without errors.
	Valid int
	// Imported is the number of rows written; always 0 for a dry run.
	Imported int
	// Errors lists row problems, capped at 1000 entries (the counts stay exact).
	Errors []ImportRowError
}

// Import loads participants from an XLSX or CSV (participant.import). Rows with errors are
// reported and skipped; valid rows are written. Replace mode first clears the table inside
// the same transaction and refuses a file without any valid row. With DryRun nothing is
// written and no audit entry is made.
func (s *Participants) Import(ctx context.Context, a domain.Actor, in ImportInput) (ImportResult, error) {
	proj, err := s.writableProject(ctx, a, in.ProjectID, domain.PermParticipantImport)
	if err != nil {
		return ImportResult{}, err
	}
	if in.Mode != ImportAppend && in.Mode != ImportReplace {
		return ImportResult{}, domain.NewValidation(domain.FieldError{Field: "mode", Reason: "must be append or replace"})
	}

	res := ImportResult{DryRun: in.DryRun, Mode: in.Mode, Errors: []ImportRowError{}}
	var valid []domain.Participant
	addErr := func(line int, field, code, msg string) {
		if len(res.Errors) < maxImportErrors {
			res.Errors = append(res.Errors, ImportRowError{Row: line, Field: field, Code: code, Message: msg})
		}
	}
	err = s.d.Sheets.Read(in.File, MaxImportRows, func(line int, name, phone string) error {
		res.Total++
		ok := true
		if utf8.RuneCountInString(name) > domain.MaxParticipantNameLen {
			addErr(line, "name", "too_long", fmt.Sprintf("must be at most %d characters", domain.MaxParticipantNameLen))
			ok = false
		}
		if utf8.RuneCountInString(phone) > domain.MaxParticipantPhoneLen {
			addErr(line, "phone", "too_long", fmt.Sprintf("must be at most %d characters", domain.MaxParticipantPhoneLen))
			ok = false
		}
		if ok {
			valid = append(valid, domain.Participant{Name: name, Phone: phone})
		}
		return nil
	})
	if err != nil {
		return ImportResult{}, err
	}
	res.Valid = len(valid)
	if in.DryRun {
		return res, nil
	}
	if in.Mode == ImportReplace && len(valid) == 0 {
		return ImportResult{}, domain.NewValidation(domain.FieldError{Field: "file", Reason: "contains no valid rows; refusing to replace the table"})
	}
	if len(valid) == 0 {
		return res, nil
	}

	now := s.d.Clock.Now()
	var added []domain.Participant
	var removed []string
	if _, _, err := domain.AllocateNumbers(proj.NextNumber, min(len(valid), domain.MaxAddRows)); err != nil {
		return ImportResult{}, err
	}
	err = s.d.Tx.Do(ctx, func(ctx context.Context) error {
		if in.Mode == ImportReplace {
			var err error
			if removed, err = s.d.Repo.Clear(ctx, in.ProjectID); err != nil {
				return fmt.Errorf("clear participants: %w", err)
			}
		}
		have, err := s.d.Repo.Count(ctx, in.ProjectID)
		if err != nil {
			return fmt.Errorf("count participants: %w", err)
		}
		if have+len(valid) > MaxProjectRows {
			return domain.NewValidation(domain.FieldError{Field: "file", Reason: fmt.Sprintf("a project holds at most %d rows", MaxProjectRows)})
		}
		// The repository inserts at most domain.MaxAddRows per call to keep statements small.
		added = added[:0]
		for rest := valid; len(rest) > 0; {
			n := min(domain.MaxAddRows, len(rest))
			rows, err := s.d.Repo.Add(ctx, in.ProjectID, rest[:n], a.UserID, now)
			if err != nil {
				return fmt.Errorf("add participants: %w", err)
			}
			added = append(added, rows...)
			rest = rest[n:]
		}
		return s.d.Audit.Record(ctx, a, domain.ActionParticipantsImport, in.ProjectID, "", map[string]any{
			"mode": in.Mode, "total": res.Total, "valid": res.Valid, "imported": len(added), "deleted": len(removed),
		})
	})
	if err != nil {
		return ImportResult{}, err
	}
	res.Imported = len(added)
	if len(removed) > 0 {
		s.publishDeletes(in.ProjectID, removed)
	}
	s.publishUpserts(in.ProjectID, added)
	return res, nil
}
