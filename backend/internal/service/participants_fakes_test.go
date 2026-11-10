package service

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

var testNow = time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)

type ptFixedClock struct{ t time.Time }

func (c *ptFixedClock) Now() time.Time { return c.t }

// fakeTx runs fn directly and counts calls; it does not roll anything back.
type fakeTx struct{ calls int }

func (f *fakeTx) Do(ctx context.Context, fn func(ctx context.Context) error) error {
	f.calls++
	return fn(ctx)
}

type fakeProjects struct {
	byID map[string]domain.Project
	gets int
}

func (f *fakeProjects) Get(_ context.Context, id string) (domain.Project, error) {
	f.gets++
	p, ok := f.byID[id]
	if !ok {
		return domain.Project{}, domain.ErrNotFound
	}
	return p, nil
}

type fakeLocks struct{ locks map[string]domain.RowLock }

func (f *fakeLocks) EnsureFree(_ context.Context, rowID, userID string) error {
	l, ok := f.locks[rowID]
	if !ok {
		return nil
	}
	return l.EnsureAvailableTo(userID, testNow)
}

type published struct {
	project string
	ev      domain.Event
}

type fakeNotifier struct {
	mu     sync.Mutex
	events []published
}

func (f *fakeNotifier) Publish(projectID string, ev domain.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, published{projectID, ev})
}

type auditCall struct {
	actor           string
	action, project string
	entity          string
	meta            map[string]any
}

type fakeAuditRecorder struct {
	calls []auditCall
	err   error
}

func (f *fakeAuditRecorder) Record(_ context.Context, a domain.Actor, action, projectID, entityID string, meta map[string]any) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, auditCall{a.UserID, action, projectID, entityID, meta})
	return nil
}

// fakeParticipantRepo is an in-memory ParticipantRepo mirroring the SQL semantics.
type fakeParticipantRepo struct {
	rows       map[string]domain.Participant
	nextNumber map[string]int
	finished   map[string]bool
	seq        int
	updateErr  error // forces UpdateIfVersion to fail
	stamps     int
	lists      int
}

func newPtFakeRepo() *fakeParticipantRepo {
	return &fakeParticipantRepo{rows: map[string]domain.Participant{}, nextNumber: map[string]int{}, finished: map[string]bool{}}
}

func (f *fakeParticipantRepo) sorted(projectID, q string) []domain.Participant {
	var out []domain.Participant
	for _, p := range f.rows {
		if p.ProjectID != projectID {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(p.Name), strings.ToLower(q)) && !strings.Contains(p.Phone, q) {
			continue
		}
		out = append(out, p)
	}
	slices.SortFunc(out, func(a, b domain.Participant) int { return a.Number - b.Number })
	return out
}

func (f *fakeParticipantRepo) List(_ context.Context, projectID, q string) ([]domain.Participant, error) {
	f.lists++
	return f.sorted(projectID, q), nil
}

func (f *fakeParticipantRepo) Stamp(_ context.Context, projectID, q string) (int, int64, time.Time, error) {
	f.stamps++
	rows := f.sorted(projectID, q)
	var sum int64
	var last time.Time
	for _, p := range rows {
		sum += int64(p.Version)
		if p.UpdatedAt.After(last) {
			last = p.UpdatedAt
		}
	}
	return len(rows), sum, last, nil
}

func (f *fakeParticipantRepo) Count(_ context.Context, projectID string) (int, error) {
	return len(f.sorted(projectID, "")), nil
}

func (f *fakeParticipantRepo) Get(_ context.Context, id string) (domain.Participant, error) {
	p, ok := f.rows[id]
	if !ok {
		return domain.Participant{}, domain.ErrNotFound
	}
	return p, nil
}

func (f *fakeParticipantRepo) Add(_ context.Context, projectID string, drafts []domain.Participant, by string, now time.Time) ([]domain.Participant, error) {
	if f.finished[projectID] {
		return nil, domain.ErrProjectFinished
	}
	if f.nextNumber[projectID] == 0 {
		f.nextNumber[projectID] = 1
	}
	var out []domain.Participant
	for _, d := range drafts {
		f.seq++
		p := domain.Participant{
			ID: fmt.Sprintf("p%04d", f.seq), ProjectID: projectID, Number: f.nextNumber[projectID],
			Name: d.Name, Phone: d.Phone, Version: 1, UpdatedBy: by, UpdatedAt: now,
		}
		f.nextNumber[projectID]++
		f.rows[p.ID] = p
		out = append(out, p)
	}
	return out, nil
}

func (f *fakeParticipantRepo) AddEmpty(ctx context.Context, projectID string, count int, by string, now time.Time) ([]domain.Participant, error) {
	return f.Add(ctx, projectID, make([]domain.Participant, count), by, now)
}

func (f *fakeParticipantRepo) UpdateIfVersion(_ context.Context, p domain.Participant) (domain.Participant, error) {
	if f.updateErr != nil {
		return domain.Participant{}, f.updateErr
	}
	cur, ok := f.rows[p.ID]
	if !ok || cur.Version != p.Version-1 {
		return domain.Participant{}, domain.ErrVersionConflict
	}
	cur.Name, cur.Phone, cur.Version, cur.UpdatedBy, cur.UpdatedAt = p.Name, p.Phone, p.Version, p.UpdatedBy, p.UpdatedAt
	f.rows[p.ID] = cur
	return cur, nil
}

func (f *fakeParticipantRepo) UpdateMany(_ context.Context, projectID string, changes []domain.ParticipantChange, by string, now time.Time) ([]domain.Participant, error) {
	var out []domain.Participant
	for _, c := range changes {
		cur, ok := f.rows[c.ID]
		if !ok || cur.ProjectID != projectID || cur.Version != c.Version {
			continue
		}
		if c.SetName {
			cur.Name = c.Name
		}
		if c.SetPhone {
			cur.Phone = c.Phone
		}
		cur.Version, cur.UpdatedBy, cur.UpdatedAt = cur.Version+1, by, now
		f.rows[c.ID] = cur
		out = append(out, cur)
	}
	slices.SortFunc(out, func(a, b domain.Participant) int { return a.Number - b.Number })
	return out, nil
}

func (f *fakeParticipantRepo) ClearByIDs(ctx context.Context, projectID string, ids []string, by string, now time.Time) ([]domain.Participant, error) {
	var changes []domain.ParticipantChange
	for _, id := range ids {
		if p, ok := f.rows[id]; ok && p.ProjectID == projectID && (p.Name != "" || p.Phone != "") {
			changes = append(changes, domain.ParticipantChange{ID: id, SetName: true, SetPhone: true, Version: p.Version})
		}
	}
	return f.UpdateMany(ctx, projectID, changes, by, now)
}

func (f *fakeParticipantRepo) ListByIDs(_ context.Context, projectID string, ids []string) ([]domain.Participant, error) {
	var out []domain.Participant
	for _, id := range ids {
		if p, ok := f.rows[id]; ok && p.ProjectID == projectID {
			out = append(out, p)
		}
	}
	slices.SortFunc(out, func(a, b domain.Participant) int { return a.Number - b.Number })
	return out, nil
}

// fakeSheets implements SheetCodec with a trivial line format: "name|phone" per line, a
// leading "header" line is skipped. It also records what Write received.
type fakeSheets struct {
	readErr   error
	wrote     []domain.Participant
	wroteFmt  string
	maxRowsIn int
}

func (f *fakeSheets) Read(r io.Reader, maxRows int, emit func(line int, name, phone string) error) error {
	f.maxRowsIn = maxRows
	if f.readErr != nil {
		return f.readErr
	}
	data, _ := io.ReadAll(r)
	for i, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) == "" || ln == "header" {
			continue
		}
		name, phone, _ := strings.Cut(ln, "|")
		if err := emit(i+1, name, phone); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeSheets) Write(w io.Writer, format string, rows []domain.Participant) error {
	f.wroteFmt, f.wrote = format, rows
	_, err := io.WriteString(w, "file:"+format)
	return err
}

// fixture bundles a Participants service with its fakes.
type fixture struct {
	svc      *Participants
	repo     *fakeParticipantRepo
	projects *fakeProjects
	locks    *fakeLocks
	notify   *fakeNotifier
	audit    *fakeAuditRecorder
	tx       *fakeTx
	sheets   *fakeSheets
	clock    *ptFixedClock
}

const (
	projActive   = "proj-active"
	projFinished = "proj-finished"
)

func newFixture() *fixture {
	f := &fixture{
		repo:   newPtFakeRepo(),
		locks:  &fakeLocks{locks: map[string]domain.RowLock{}},
		notify: &fakeNotifier{},
		audit:  &fakeAuditRecorder{},
		tx:     &fakeTx{},
		sheets: &fakeSheets{},
		clock:  &ptFixedClock{testNow},
		projects: &fakeProjects{byID: map[string]domain.Project{
			projActive:   {ID: projActive, Title: "Raffle", Status: domain.ProjectActive, NextNumber: 1},
			projFinished: {ID: projFinished, Title: "Old", Status: domain.ProjectFinished, NextNumber: 1},
		}},
	}
	f.repo.finished[projFinished] = true
	f.svc = NewParticipants(ParticipantsDeps{
		Repo: f.repo, Projects: f.projects, Locks: f.locks, Notify: f.notify, Audit: f.audit,
		Tx: f.tx, Clock: f.clock, Sheets: f.sheets,
	})
	return f
}

// ptActorWith builds an actor holding exactly the given permissions.
func ptActorWith(user string, perms ...domain.Permission) domain.Actor {
	return domain.Actor{UserID: user, Perms: domain.NewPermissionSet(perms...)}
}

// operator has the default worker permissions plus delete, clear and import.
func operator() domain.Actor {
	return ptActorWith("user-1",
		domain.PermProjectView, domain.PermProjectViewFinished,
		domain.PermParticipantView, domain.PermParticipantEdit, domain.PermParticipantPrint,
		domain.PermParticipantExport, domain.PermParticipantImport, domain.PermParticipantDelete, domain.PermParticipantClear)
}

func (f *fixture) seed(project string, n int) []domain.Participant {
	was := f.repo.finished[project]
	f.repo.finished[project] = false // seeding bypasses the read-only guard
	rows, _ := f.repo.AddEmpty(context.Background(), project, n, "", testNow.Add(-time.Hour))
	f.repo.finished[project] = was
	return rows
}
