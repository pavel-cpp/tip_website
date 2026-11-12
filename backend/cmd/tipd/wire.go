package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/pavel-cpp/tip_website/backend/api"
	httpapi "github.com/pavel-cpp/tip_website/backend/internal/handler/http"
	"github.com/pavel-cpp/tip_website/backend/internal/handler/ws"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/clock"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/config"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/db"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/ids"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/imaging"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/security"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/sheets"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/sysinfo"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/blobfs"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/memory"
	"github.com/pavel-cpp/tip_website/backend/internal/repository/postgres"
	tokenstore "github.com/pavel-cpp/tip_website/backend/internal/repository/redis"
	"github.com/pavel-cpp/tip_website/backend/internal/service"
	"github.com/pavel-cpp/tip_website/backend/web"
)

const (
	auditRetentionInterval = 24 * time.Hour
	blobGCInterval         = 24 * time.Hour
	redisPingInterval      = 15 * time.Second
	lokiTimeout            = 2 * time.Second
	// pepperVersion is the version stamped into new password hashes; bump it together with a
	// pepper rotation (the previous peppers would then be passed to security.NewHasher).
	pepperVersion = 1
)

// app is the assembled process: the services and the HTTP router built from them.
type app struct {
	cfg     config.Config
	logger  zerolog.Logger
	metrics *metrics.Metrics

	conn  *sql.DB
	redis *goredis.Client

	hub    *memory.Hub
	ws     *ws.Handler
	router http.Handler
	sched  *service.Scheduler

	users    *service.Users
	userRepo *postgres.UserRepo
	tokens   service.TokenStore
	hasher   *security.Hasher
	ids      ids.UUIDv7

	accounts  accountAudit
	rolesSync func(context.Context) error

	replayWindow time.Duration

	bgWG     sync.WaitGroup
	bgCancel context.CancelFunc
}

// appOption tweaks the assembly; production passes none.
type appOption func(*app)

// withReplayWindow shortens the refresh replay window (service.DefaultReplayWindow) for tests.
func withReplayWindow(d time.Duration) appOption { return func(a *app) { a.replayWindow = d } }

// newApp wires every layer by hand. It opens the pools, applies the migrations (AUTO_MIGRATE),
// synchronizes the permission catalog and creates the bootstrap administrator, so the
// returned router is ready to serve. Close releases the pools.
func newApp(ctx context.Context, cfg config.Config, logger zerolog.Logger, m *metrics.Metrics, opts ...appOption) (_ *app, err error) {
	a := &app{cfg: cfg, logger: logger, metrics: m}
	for _, o := range opts {
		o(a)
	}
	defer func() {
		if err != nil {
			a.Close()
		}
	}()

	observe := db.WithQueryObserver(func(sql string, d time.Duration) { m.ObserveQuery(metrics.QueryKind(sql), d) })
	if a.conn, err = db.Open(ctx, cfg.DatabaseURL.Reveal(), observe); err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}
	m.RegisterDB(a.conn)
	if cfg.AutoMigrate {
		mctx, cancel := context.WithTimeout(ctx, migrateTimeout)
		err = runMigrations(mctx, a.conn, logger)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("migrations: %w", err)
		}
	}
	if a.redis, err = tokenstore.Open(cfg.RedisURL.Reveal()); err != nil {
		return nil, fmt.Errorf("redis: %w", err)
	}

	if err = a.wire(ctx); err != nil {
		return nil, err
	}
	if err = a.prepareData(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// wire creates the repositories, services and handlers.
func (a *app) wire(ctx context.Context) error {
	cfg, m, logger := a.cfg, a.metrics, a.logger
	clk := clock.System{}
	tx := postgres.NewTxManager(a.conn)
	a.userRepo = postgres.NewUserRepo(a.conn)
	roleRepo := postgres.NewRoleRepo(a.conn)
	authzRepo := postgres.NewAuthzRepo(a.conn)
	projectRepo := postgres.NewProjectRepo(a.conn)
	participantRepo := postgres.NewParticipantRepo(a.conn)
	auditRepo := postgres.NewAuditRepo(a.conn)

	var err error
	if a.hasher, err = security.NewHasher(cfg.PasswordPepper.Reveal(), pepperVersion, nil); err != nil {
		return fmt.Errorf("password hasher: %w", err)
	}
	codec, err := security.NewTokens(cfg.JWTAccessSecret.Reveal(), cfg.JWTRefreshSecret.Reveal())
	if err != nil {
		return fmt.Errorf("token codec: %w", err)
	}
	epoch, err := service.NewEpoch(ctx, authzRepo)
	if err != nil {
		return err
	}
	img := imaging.New(cfg.MaxImageMB<<20, cfg.MaxImagePixels)
	blobs, err := blobfs.New(cfg.DataDir, cfg.MinFreeDiskMB, cfg.UploadsMaxTotalMB)
	if err != nil {
		return fmt.Errorf("blob store: %w", err)
	}

	a.hub = memory.NewHub(memory.Config{Clock: clk, Metrics: wsMetrics{PromMetrics: memory.NewPromMetrics(m.Registry), m: m}})
	m.RegisterLocks(a.hub.ActiveLocks)
	epoch.Subscribe(func(int64) { a.hub.BroadcastReauth("") })

	rawTokens := tokenstore.NewTokenStore(a.redis)
	a.tokens = meteredTokens{TokenStore: rawTokens, m: m}
	warns := logging.NewWarnSampler()
	onStoreError := func(op string, err error) {
		warns.Warn(&logger).Err(err).Str("op", op).Msg("token store error")
	}

	auditSvc := service.NewAudit(auditRepo, clk, service.AuditConfig{
		RetentionDays: cfg.AuditRetentionDays, MaxRows: cfg.AuditMaxRows,
	})
	accounts := accountAudit{auditSvc}
	a.accounts = accounts

	authSvc := service.NewAuth(service.AuthDeps{
		Config: service.AuthConfig{
			AccessTTL: cfg.AccessTokenTTL, RefreshTTL: cfg.RefreshTokenTTL, ReplayWindow: a.replayWindow,
			FailOpen: cfg.RedisFailMode == config.FailOpen, ForcePasswordChange: cfg.ForcePasswordChange,
		},
		Users: a.userRepo, Tokens: a.tokens, Codec: codec, Hasher: a.hasher,
		Limiter: service.NewMemoryLoginLimiter(clk), Audit: accounts, Epoch: epoch,
		Clock: clk, IDs: a.ids, OnTokenStoreError: onStoreError,
		OnRefresh: func(result string) { m.TokenRefresh.WithLabelValues(result).Inc() },
	})
	a.users = service.NewUsers(service.UsersDeps{
		Users: a.userRepo, Avatars: a.userRepo, Roles: roleRepo, Authz: authzRepo, Epoch: epoch, Tx: tx,
		Tokens: a.tokens, Hasher: a.hasher, Passwords: security.RandomPassword{}, Images: avatarProcessor{img},
		Audit: accounts, Clock: clk, IDs: a.ids, RefreshTTL: cfg.RefreshTokenTTL,
		OnUserRevoked: a.hub.KickUser, OnTokenStoreError: onStoreError,
	})
	rolesSvc := service.NewRoles(service.RolesDeps{
		Roles: roleRepo, Authz: authzRepo, Epoch: epoch, Tx: tx, Audit: accounts, IDs: a.ids,
	})
	fontRepo := postgres.NewFontRepo(a.conn)
	projectsSvc := service.NewProjectService(service.ProjectsDeps{
		Repo: projectRepo, Blobs: blobs, Images: img, Audit: projectAudit{auditSvc}, Events: a.hub,
		Fonts: fontRepo, Presence: a.hub, Tx: tx, Clock: clk, IDs: a.ids,
	})
	fontsSvc := service.NewFontService(service.FontsDeps{
		Repo: fontRepo, Blobs: blobs, Audit: projectAudit{auditSvc}, Tx: tx, Clock: clk, IDs: a.ids,
	})
	participantsSvc := service.NewParticipants(service.ParticipantsDeps{
		Repo: participantRepo, Projects: projectRepo, Locks: a.hub, Notify: a.hub, Audit: auditSvc,
		Tx: tx, Clock: clk, Sheets: sheets.Codec{},
	})
	collab := service.NewCollab(a.hub, projectAccess{projectRepo}, peerDirectory{a.userRepo}, authSvc)
	a.ws = ws.New(ws.Config{Collab: collab, AllowedOrigins: cfg.AllowedOrigins})

	host := sysinfo.Host{BackupMetricsPath: cfg.BackupMetricsPath}
	dbProbe := sysinfo.Database{DB: a.conn}
	m.RegisterStorage(metrics.StorageProbes{
		DataDir: cfg.DataDir, DiskFree: host.DiskUsage, DirSize: host.DirSize, DBSize: dbProbe.Size,
	})
	redisPing := rawTokens.Ping
	redisOnFail := service.CheckFail
	if cfg.RedisFailMode == config.FailOpen {
		redisOnFail = service.CheckWarn
	}
	checks := []service.HealthCheck{
		service.NewPingCheck("postgres", service.CheckFail, func(ctx context.Context) error { return db.Ping(ctx, a.conn) }),
		service.NewPingCheck("redis", redisOnFail, redisPing),
		service.NewDiskCheck(host, cfg.DataDir, cfg.MinFreeDiskMB),
		service.NewBackupCheck(host, clk),
	}
	if cfg.LokiURL != "" && cfg.LokiURL != "off" {
		checks = append(checks, service.NewPingCheck("loki", service.CheckWarn,
			httpPing(&http.Client{Timeout: lokiTimeout}, cfg.LokiURL+"/ready")))
	}
	systemSvc := service.NewSystemService(service.SystemConfig{
		Version: versionWithCommit(), DataDir: cfg.DataDir, ObsRetentionDays: cfg.ObsRetentionDays, AuditRetentionDays: cfg.AuditRetentionDays, SwaggerEnabled: cfg.SwaggerEnabled, GrafanaURL: cfg.GrafanaURL,
	}, clk, time.Now(), host, dbProbe, checks...)

	a.router, err = httpapi.NewRouter(httpapi.Deps{
		Logger: logger, Metrics: m, NewID: a.ids.NewID,
		Ready: []httpapi.Check{
			{Name: "postgres", Fn: func(ctx context.Context) error { return db.Ping(ctx, a.conn) }},
			{Name: "redis", Fn: redisPing},
			{Name: "dataDir", Fn: func(context.Context) error { return dataDirReady(cfg.DataDir) }},
		},
		API: &httpapi.APIDeps{
			InsecureCookies: !cfg.CookieSecure,
			Auth:            meteredAuth{Auth: authSvc, m: m}, Users: meteredUsers{Users: a.users, m: m}, Roles: rolesSvc,
			Projects:     meteredProjects{ProjectService: projectsSvc, m: m},
			Fonts:        fontsSvc,
			Participants: meteredParticipants{Participants: participantsSvc, m: m}, Audit: auditSvc, System: systemSvc,
			MaxImageBytes: int64(cfg.MaxImageMB) << 20,
		},
		Auth:           meteredAuth{Auth: authSvc, m: m},
		AllowedOrigins: cfg.AllowedOrigins,
		WS:             a.ws,
		SwaggerEnabled: cfg.SwaggerEnabled,
		Spec:           api.Spec,
		SPA:            web.FS(),
	})
	if err != nil {
		return err
	}

	a.sched, err = service.NewScheduler([]service.Job{
		{Name: "audit_retention", Interval: auditRetentionInterval, Run: func(ctx context.Context) error {
			_, err := auditSvc.Retention(ctx)
			return err
		}},
		{Name: "blob_gc", Interval: blobGCInterval, Run: func(ctx context.Context) error {
			_, err := projectsSvc.CollectGarbage(ctx)
			return err
		}},
	}, service.SystemTicker, clk, func(r service.JobResult) {
		ev := logger.Info()
		if r.Err != nil {
			ev = logger.Error().Err(r.Err)
		}
		ev.Str("job", r.Name).Dur("took", r.Duration).Msg("maintenance job finished")
	})
	if err != nil {
		return fmt.Errorf("scheduler: %w", err)
	}

	a.rolesSync = rolesSvc.SyncPermissions
	return nil
}

// dataDirReady verifies the data directory exists; the blob store creates its layout in it.
func dataDirReady(dir string) error {
	st, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return errors.New("data dir is not a directory")
	}
	return nil
}

// prepareData mirrors the permission catalog into the database and creates the bootstrap
// administrator when no account exists yet.
func (a *app) prepareData(ctx context.Context) error {
	if err := a.rolesSync(ctx); err != nil {
		return fmt.Errorf("sync permissions: %w", err)
	}
	if a.cfg.BootstrapAdminLogin == "" {
		return nil
	}
	existing, err := a.userRepo.List(ctx)
	if err != nil {
		return fmt.Errorf("list users: %w", err)
	}
	if len(existing) > 0 {
		return nil
	}
	if _, err := a.users.EnsureAdmin(ctx, a.cfg.BootstrapAdminLogin, a.cfg.BootstrapAdminPassword.Reveal()); err != nil {
		return fmt.Errorf("bootstrap admin: %w", err)
	}
	a.logger.Warn().Str("login", a.cfg.BootstrapAdminLogin).
		Msg("bootstrap administrator created from the environment; change its password and remove BOOTSTRAP_ADMIN_PASSWORD")
	return nil
}

// Start launches the background work (maintenance jobs, Redis ping) until Stop or ctx ends.
func (a *app) Start(ctx context.Context) {
	ctx, a.bgCancel = context.WithCancel(ctx)
	a.bgWG.Add(2)
	go func() {
		defer a.bgWG.Done()
		a.sched.Run(ctx)
	}()
	go func() {
		defer a.bgWG.Done()
		pingEvery(ctx, redisPingInterval, func(ctx context.Context) error { return a.redis.Ping(ctx).Err() }, func(up bool) {
			if up {
				a.metrics.RedisUp.Set(1)
			} else {
				a.metrics.RedisUp.Set(0)
			}
		})
	}()
}

// Stop ends the background work and waits for it.
func (a *app) Stop() {
	if a.bgCancel != nil {
		a.bgCancel()
	}
	a.bgWG.Wait()
}

// Close releases the database and Redis pools.
func (a *app) Close() {
	if a.redis != nil {
		_ = a.redis.Close()
	}
	if a.conn != nil {
		_ = a.conn.Close()
	}
}
