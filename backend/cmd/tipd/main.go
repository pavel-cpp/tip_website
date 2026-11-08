// Command tipd is the TIP Web server. Dependencies are wired by hand in this package.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
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
		return errors.New("usage: tipd <serve|migrate|healthcheck|admin|version>")
	}
	switch args[0] {
	case "serve":
		return serve()
	case "migrate":
		return migrate()
	case "healthcheck":
		os.Exit(runHealthcheck())
		return nil
	case "admin":
		return adminCommand(args[1:], os.Getenv, os.Stdout)
	case "version", "-version", "--version":
		fmt.Printf("tipd %s (%s)\n", version, commit)
		return nil
	default:
		return fmt.Errorf("unknown command %q (want serve, migrate, healthcheck, admin or version)", args[0])
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

	a, err := newApp(ctx, cfg, logger, m)
	if err != nil {
		logger.Error().Err(err).Msg("startup failed")
		return err
	}
	defer a.Close()
	a.Start(ctx)

	public := httpapi.NewServer(cfg.HTTPAddr, a.router, logging.NewStdLogger(logger, "http"))
	internal := m.NewInternalServer(cfg.InternalAddr)
	internal.ErrorLog = logging.NewStdLogger(logger, "internal")

	// Listeners are opened here so that shutdown can stop accepting before it drains.
	listeners := map[string]net.Listener{}
	for name, srv := range map[string]*http.Server{"public": public, "internal": internal} {
		ln, err := net.Listen("tcp", srv.Addr)
		if err != nil {
			logger.Error().Err(err).Str("server", name).Msg("listen failed")
			return fmt.Errorf("%s listener: %w", name, err)
		}
		listeners[name] = ln
	}

	serveErr := make(chan error, 2)
	for name, srv := range map[string]*http.Server{"public": public, "internal": internal} {
		go func() {
			logger.Info().Str("server", name).Str("addr", srv.Addr).Str("version", version).Msg("listening")
			if err := srv.Serve(listeners[name]); !errors.Is(err, http.ErrServerClosed) {
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

	// Order: stop accepting, end the WebSocket sessions (hijacked connections are invisible to
	// http.Server.Shutdown), drain the HTTP server, stop background jobs, close the pools.
	sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	for _, ln := range listeners {
		_ = ln.Close()
	}
	if err := a.ws.Shutdown(sctx); err != nil {
		logger.Error().Err(err).Msg("websocket shutdown")
	}
	if err := public.Shutdown(sctx); err != nil {
		logger.Error().Err(err).Msg("public server shutdown")
	}
	if err := internal.Shutdown(sctx); err != nil {
		logger.Error().Err(err).Msg("internal server shutdown")
	}
	a.Stop()
	logger.Info().Msg("stopped")
	return runErr
}
