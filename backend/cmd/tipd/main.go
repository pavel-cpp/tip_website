// Command tipd is the TIP Web server. Dependencies are wired by hand in this package.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/rs/zerolog"

	httpapi "github.com/pavel-cpp/tip_website/backend/internal/handler/http"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/clock"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/config"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/db"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/ids"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/postgres"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
	"github.com/pavel-cpp/tip_website/backend/migrations"
)

// Set at build time with -ldflags "-X main.version=... -X main.commit=...".
var (
	version = "dev"
	commit  = "none"
)

const (
	migrateTimeout  = 2 * time.Minute
	shutdownTimeout = 20 * time.Second
)

// Compile-time proof that the platform and repository types satisfy the service ports.
var (
	_ service.Clock = clock.System{}
	_ service.IDGen = ids.UUIDv7{}
	_ service.Tx    = (*postgres.TxManager)(nil)
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "tipd:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: tipd <serve|migrate|admin>")
	}
	switch args[0] {
	case "serve":
		return serve()
	case "migrate":
		return migrate()
	case "admin":
		fmt.Println("not implemented yet")
		return nil
	default:
		return fmt.Errorf("unknown command %q (want serve, migrate or admin)", args[0])
	}
}

// migrate applies pending migrations and exits.
func migrate() error {
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	logger, closeLog := logging.New(logging.Options{Level: cfg.LogLevel})
	defer func() { _ = closeLog() }()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	conn, err := db.Open(ctx, cfg.DatabaseURL.Reveal())
	if err != nil {
		return err
	}
	defer conn.Close()
	return runMigrations(ctx, conn, logger)
}

// runMigrations applies the embedded goose migrations.
func runMigrations(ctx context.Context, conn *sql.DB, logger zerolog.Logger) error {
	return db.Migrate(ctx, conn, migrations.FS, ".", goose.WithLogger(logging.Goose{L: logger}))
}

func serve() error {
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	m := metrics.New(version, commit)
	logger, closeLog := logging.New(logging.Options{
		Level:     cfg.LogLevel,
		OnDropped: func(n int) { m.LogDropped.Add(float64(n)) },
	})
	defer func() { _ = closeLog() }()
	logger = logger.With().Str("service", "tipd").Logger()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	conn, err := db.Open(ctx, cfg.DatabaseURL.Reveal())
	if err != nil {
		logger.Error().Err(err).Msg("database unavailable")
		return err
	}
	defer conn.Close()
	m.RegisterDB(conn)

	if cfg.AutoMigrate {
		mctx, cancel := context.WithTimeout(ctx, migrateTimeout)
		err := runMigrations(mctx, conn, logger)
		cancel()
		if err != nil {
			logger.Error().Err(err).Msg("migrations failed")
			return err
		}
	}

	router := httpapi.NewRouter(httpapi.Deps{
		Logger:  logger,
		Metrics: m,
		NewID:   ids.UUIDv7{}.NewID,
		Ready: []httpapi.Check{
			{Name: "database", Fn: func(ctx context.Context) error { return db.Ping(ctx, conn) }},
		},
	})
	public := httpapi.NewServer(cfg.HTTPAddr, router, logging.NewStdLogger(logger, "http"))
	internal := m.NewInternalServer(cfg.InternalAddr)
	internal.ErrorLog = logging.NewStdLogger(logger, "internal")

	serveErr := make(chan error, 2)
	for name, srv := range map[string]*http.Server{"public": public, "internal": internal} {
		go func() {
			logger.Info().Str("server", name).Str("addr", srv.Addr).Msg("listening")
			if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				serveErr <- fmt.Errorf("%s server: %w", name, err)
			}
		}()
	}

	var runErr error
	select {
	case <-ctx.Done():
		logger.Info().Msg("shutdown signal received")
	case runErr = <-serveErr:
		logger.Error().Err(runErr).Msg("server failed")
	}

	sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := public.Shutdown(sctx); err != nil {
		logger.Error().Err(err).Msg("public server shutdown")
	}
	if err := internal.Shutdown(sctx); err != nil {
		logger.Error().Err(err).Msg("internal server shutdown")
	}
	logger.Info().Msg("stopped")
	return runErr
}
