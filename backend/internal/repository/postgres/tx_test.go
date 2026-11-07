package postgres

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver for the integration test

	"github.com/pavel-cpp/tip_website/backend/internal/platform/dbtest"
)

// fakeDriver records transaction lifecycle calls so the manager is testable without a server.
type fakeDriver struct {
	mu     sync.Mutex
	events []string
}

func (d *fakeDriver) record(e string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.events = append(d.events, e)
}

func (d *fakeDriver) got() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.events...)
}

func (d *fakeDriver) Open(string) (driver.Conn, error) { return &fakeConn{d}, nil }

type fakeConn struct{ d *fakeDriver }

func (c *fakeConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unsupported") }
func (c *fakeConn) Close() error                        { return nil }
func (c *fakeConn) Begin() (driver.Tx, error)           { c.d.record("begin"); return &fakeTx{c.d}, nil }

type fakeTx struct{ d *fakeDriver }

func (t *fakeTx) Commit() error   { t.d.record("commit"); return nil }
func (t *fakeTx) Rollback() error { t.d.record("rollback"); return nil }

type fakeConnector struct{ d *fakeDriver }

func (c fakeConnector) Connect(context.Context) (driver.Conn, error) { return &fakeConn{c.d}, nil }
func (c fakeConnector) Driver() driver.Driver                        { return c.d }

func newFakeManager() (*TxManager, *fakeDriver) {
	d := &fakeDriver{}
	return NewTxManager(sql.OpenDB(fakeConnector{d})), d
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestDoCommitsOnSuccess(t *testing.T) {
	m, d := newFakeManager()
	err := m.Do(context.Background(), func(ctx context.Context) error {
		if _, ok := m.Querier(ctx).(*sql.Tx); !ok {
			t.Error("Querier inside Do must return the transaction")
		}
		return nil
	})
	if err != nil || !equal(d.got(), []string{"begin", "commit"}) {
		t.Fatalf("err=%v events=%v", err, d.got())
	}
}

func TestDoRollsBackOnError(t *testing.T) {
	m, d := newFakeManager()
	boom := errors.New("boom")
	err := m.Do(context.Background(), func(context.Context) error { return boom })
	if !errors.Is(err, boom) || !equal(d.got(), []string{"begin", "rollback"}) {
		t.Fatalf("err=%v events=%v", err, d.got())
	}
}

func TestDoRollsBackOnPanic(t *testing.T) {
	m, d := newFakeManager()
	func() {
		defer func() {
			if recover() == nil {
				t.Error("panic must propagate")
			}
		}()
		_ = m.Do(context.Background(), func(context.Context) error { panic("oops") })
	}()
	if !equal(d.got(), []string{"begin", "rollback"}) {
		t.Fatalf("events=%v", d.got())
	}
}

func TestNestedDoJoinsOuterTransaction(t *testing.T) {
	m, d := newFakeManager()
	err := m.Do(context.Background(), func(ctx context.Context) error {
		return m.Do(ctx, func(context.Context) error { return nil })
	})
	if err != nil || !equal(d.got(), []string{"begin", "commit"}) {
		t.Fatalf("err=%v events=%v", err, d.got())
	}
}

func TestQuerierFallsBackToPool(t *testing.T) {
	m, _ := newFakeManager()
	if _, ok := m.Querier(context.Background()).(*sql.DB); !ok {
		t.Error("outside a transaction Querier must return the pool")
	}
}

func TestTxManagerAgainstPostgres(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("pgx", dbtest.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	m := NewTxManager(db)
	if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS tx_test; CREATE TABLE tx_test (v int)"); err != nil {
		t.Fatal(err)
	}
	count := func() int {
		var n int
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM tx_test").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	boom := errors.New("boom")
	err = m.Do(ctx, func(ctx context.Context) error {
		if _, err := m.Querier(ctx).ExecContext(ctx, "INSERT INTO tx_test VALUES (1)"); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) || count() != 0 {
		t.Fatalf("rollback failed: err=%v count=%d", err, count())
	}
	err = m.Do(ctx, func(ctx context.Context) error {
		_, err := m.Querier(ctx).ExecContext(ctx, "INSERT INTO tx_test VALUES (1)")
		return err
	})
	if err != nil || count() != 1 {
		t.Fatalf("commit failed: err=%v count=%d", err, count())
	}
}
