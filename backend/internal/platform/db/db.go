// Package db opens the PostgreSQL pool and runs schema migrations.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib" // also registers the "pgx" database/sql driver
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// Pool limits sized for a 2 GB server running Postgres with max_connections=20.
const (
	maxOpenConns    = 10
	maxIdleConns    = 5
	connMaxLifetime = 30 * time.Minute
)

// migrationLockID is the advisory lock key serialising concurrent migrators.
const migrationLockID int64 = 0x7469705f6d696772 // "tip_migr"

// Open creates a pool and verifies connectivity.
func Open(ctx context.Context, dsn string, opts ...Option) (*sql.DB, error) {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	var db *sql.DB
	if o.observer == nil {
		var err error
		if db, err = sql.Open("pgx", dsn); err != nil {
			return nil, fmt.Errorf("open database: %w", err)
		}
	} else {
		cfg, err := pgx.ParseConfig(dsn)
		if err != nil {
			return nil, fmt.Errorf("parse database url: %w", err)
		}
		cfg.Tracer = queryTracer{obs: o.observer}
		db = sql.OpenDB(stdlib.GetConnector(*cfg))
	}
	db.SetMaxOpenConns(maxOpenConns)
	db.SetMaxIdleConns(maxIdleConns)
	db.SetConnMaxLifetime(connMaxLifetime)
	if err := Ping(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// Ping checks that the database answers within ctx.
func Ping(ctx context.Context, db *sql.DB) error {
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping database: %w", err)
	}
	return nil
}

// Migrate applies all pending goose migrations found in dir of fsys. A PostgreSQL advisory
// lock held for the whole run makes concurrent starts safe. Extra options (for example a
// logger) are passed to the goose provider.
func Migrate(ctx context.Context, db *sql.DB, fsys fs.FS, dir string, opts ...goose.ProviderOption) error {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		return fmt.Errorf("migrations dir %q: %w", dir, err)
	}
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(migrationLockID))
	if err != nil {
		return fmt.Errorf("create migration locker: %w", err)
	}
	opts = append([]goose.ProviderOption{goose.WithSessionLocker(locker)}, opts...)
	p, err := goose.NewProvider(goose.DialectPostgres, db, sub, opts...)
	if err != nil {
		return fmt.Errorf("create migration provider: %w", err)
	}
	if _, err := p.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}
