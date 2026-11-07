// Package postgres contains the PostgreSQL-backed repositories and the transaction manager.
package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// DBTX is the query surface shared by *sql.DB and *sql.Tx.
type DBTX interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type txKey struct{}

// TxManager implements service.Tx by keeping the active *sql.Tx in the context.
type TxManager struct{ db *sql.DB }

// NewTxManager returns a manager over the pool.
func NewTxManager(db *sql.DB) *TxManager { return &TxManager{db: db} }

// Do runs fn in a transaction. If ctx already carries one, fn joins it and the outermost
// call owns commit and rollback, so nested service calls compose without savepoints.
func (m *TxManager) Do(ctx context.Context, fn func(ctx context.Context) error) (err error) {
	if _, ok := ctx.Value(txKey{}).(*sql.Tx); ok {
		return fn(ctx)
	}
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
	}()
	if err := fn(context.WithValue(ctx, txKey{}, tx)); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil && !errors.Is(rbErr, sql.ErrTxDone) {
			return errors.Join(err, fmt.Errorf("rollback transaction: %w", rbErr))
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// Querier returns the transaction carried by ctx, or the pool when there is none.
func (m *TxManager) Querier(ctx context.Context) DBTX { return Querier(ctx, m.db) }

// Querier returns the transaction carried by ctx, or fallback (normally the pool).
// Repositories call it for every statement so they transparently join the caller's Tx.
func Querier(ctx context.Context, fallback DBTX) DBTX {
	if tx, ok := ctx.Value(txKey{}).(*sql.Tx); ok {
		return tx
	}
	return fallback
}
