// Package config loads and validates the process configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const minSecretBytes = 32

// Secret is a sensitive string that never renders its value through fmt or logging verbs.
type Secret string

// String returns a fixed placeholder so that accidental printing leaks nothing.
func (s Secret) String() string {
	if s == "" {
		return ""
	}
	return "[redacted]"
}

// GoString covers %#v.
func (s Secret) GoString() string { return `"` + s.String() + `"` }

// MarshalText covers encoding/json and other text encoders.
func (s Secret) MarshalText() ([]byte, error) { return []byte(s.String()), nil }

// Reveal returns the raw value; call it only where the secret is actually used.
func (s Secret) Reveal() string { return string(s) }

// FailMode selects how access tokens are checked when Redis is unavailable.
type FailMode string

// Supported Redis failure modes.
const (
	FailOpen   FailMode = "open"
	FailClosed FailMode = "closed"
)

// Config is the validated process configuration.
type Config struct {
	HTTPAddr     string
	InternalAddr string
	DatabaseURL  Secret
	RedisURL     Secret
	AutoMigrate  bool
	DataDir      string

	AllowedOrigins []string

	JWTAccessSecret  Secret
	JWTRefreshSecret Secret
	PasswordPepper   Secret
	AccessTokenTTL   time.Duration
	RefreshTokenTTL  time.Duration

	RedisFailMode       FailMode
	ForcePasswordChange bool
	SwaggerEnabled      bool

	BootstrapAdminLogin    string
	BootstrapAdminPassword Secret

	MaxImageMB         int
	MaxImagePixels     int
	MinFreeDiskMB      int
	UploadsMaxTotalMB  int
	AuditRetentionDays int
	AuditMaxRows       int

	LogLevel         string
	ObsRetentionDays int
	// LokiURL is the base URL probed by the admin system page; "off" disables the check.
	LokiURL string
	// BackupMetricsPath is the Prometheus textfile written by the backup container.
	BackupMetricsPath string
}

// String renders the config for diagnostics. Secret fields redact themselves, and the
// bootstrap credentials are omitted entirely.
func (c Config) String() string {
	return fmt.Sprintf("{http=%s internal=%s data_dir=%s log_level=%s database_url=%v redis_url=%v "+
		"auto_migrate=%t swagger=%t force_password_change=%t redis_fail_mode=%s access_ttl=%s refresh_ttl=%s "+
		"jwt_access=%v jwt_refresh=%v pepper=%v}",
		c.HTTPAddr, c.InternalAddr, c.DataDir, c.LogLevel, c.DatabaseURL, c.RedisURL,
		c.AutoMigrate, c.SwaggerEnabled, c.ForcePasswordChange, c.RedisFailMode, c.AccessTokenTTL, c.RefreshTokenTTL,
		c.JWTAccessSecret, c.JWTRefreshSecret, c.PasswordPepper)
}

// FromEnv loads the configuration from the process environment.
func FromEnv() (Config, error) { return Load(os.Getenv) }

// Load builds a Config using getenv and reports all problems at once.
func Load(getenv func(string) string) (Config, error) {
	l := loader{get: getenv}
	c := Config{
		HTTPAddr:     l.str("HTTP_ADDR", ":8080"),
		InternalAddr: l.str("INTERNAL_ADDR", ":9090"),
		DatabaseURL:  Secret(l.required("DATABASE_URL")),
		RedisURL:     Secret(l.required("REDIS_URL")),
		AutoMigrate:  l.boolean("AUTO_MIGRATE", true),
		DataDir:      l.str("DATA_DIR", "/data"),

		JWTAccessSecret:  Secret(l.required("JWT_ACCESS_SECRET")),
		JWTRefreshSecret: Secret(l.required("JWT_REFRESH_SECRET")),
		PasswordPepper:   Secret(l.required("PASSWORD_PEPPER")),
		AccessTokenTTL:   l.duration("ACCESS_TOKEN_TTL", 15*time.Minute),
		RefreshTokenTTL:  l.duration("REFRESH_TOKEN_TTL", 720*time.Hour),

		RedisFailMode:       FailMode(l.str("REDIS_FAIL_MODE", string(FailOpen))),
		ForcePasswordChange: l.boolean("FORCE_PASSWORD_CHANGE", false),
		SwaggerEnabled:      l.boolean("SWAGGER_ENABLED", true),

		BootstrapAdminLogin:    l.str("BOOTSTRAP_ADMIN_LOGIN", ""),
		BootstrapAdminPassword: Secret(l.str("BOOTSTRAP_ADMIN_PASSWORD", "")),

		MaxImageMB:         l.positiveInt("MAX_IMAGE_MB", 10),
		MaxImagePixels:     l.positiveInt("MAX_IMAGE_PIXELS", 16000000),
		MinFreeDiskMB:      l.positiveInt("MIN_FREE_DISK_MB", 1024),
		UploadsMaxTotalMB:  l.positiveInt("UPLOADS_MAX_TOTAL_MB", 800),
		AuditRetentionDays: l.positiveInt("AUDIT_RETENTION_DAYS", 30),
		AuditMaxRows:       l.positiveInt("AUDIT_MAX_ROWS", 100000),

		LogLevel:         strings.ToLower(l.str("LOG_LEVEL", "info")),
		ObsRetentionDays: l.positiveInt("OBS_RETENTION_DAYS", 3),
		LokiURL:          l.str("LOKI_URL", "http://loki:3100"),

		BackupMetricsPath: l.str("BACKUP_METRICS_PATH", "/backups/metrics/backup.prom"),
	}
	for _, o := range strings.Split(l.str("ALLOWED_ORIGINS", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.AllowedOrigins = append(c.AllowedOrigins, o)
		}
	}
	c.validate(&l)
	return c, l.err()
}

func (c Config) validate(l *loader) {
	for _, s := range []struct {
		name string
		val  Secret
	}{{"JWT_ACCESS_SECRET", c.JWTAccessSecret}, {"JWT_REFRESH_SECRET", c.JWTRefreshSecret}, {"PASSWORD_PEPPER", c.PasswordPepper}} {
		if s.val != "" && len(s.val) < minSecretBytes {
			l.fail("%s must be at least %d bytes", s.name, minSecretBytes)
		}
	}
	if c.JWTAccessSecret != "" && c.JWTAccessSecret == c.JWTRefreshSecret {
		l.fail("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ")
	}
	if c.RedisFailMode != FailOpen && c.RedisFailMode != FailClosed {
		l.fail("REDIS_FAIL_MODE must be %q or %q", FailOpen, FailClosed)
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		l.fail("LOG_LEVEL must be one of debug, info, warn, error")
	}
	if (c.BootstrapAdminLogin == "") != (c.BootstrapAdminPassword == "") {
		l.fail("BOOTSTRAP_ADMIN_LOGIN and BOOTSTRAP_ADMIN_PASSWORD must be set together")
	}
	if c.BootstrapAdminPassword != "" && len(c.BootstrapAdminPassword) < 8 {
		l.fail("BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters")
	}
	if c.AccessTokenTTL <= 0 || c.RefreshTokenTTL <= c.AccessTokenTTL {
		l.fail("token TTLs must be positive and REFRESH_TOKEN_TTL must exceed ACCESS_TOKEN_TTL")
	}
	if c.DatabaseURL != "" && !hasScheme(c.DatabaseURL.Reveal(), "postgres", "postgresql") {
		l.fail("DATABASE_URL must be a postgres:// URL")
	}
	if c.RedisURL != "" && !hasScheme(c.RedisURL.Reveal(), "redis", "rediss") {
		l.fail("REDIS_URL must be a redis:// URL")
	}
	if c.ObsRetentionDays > 5 {
		l.fail("OBS_RETENTION_DAYS must not exceed 5")
	}
}

func hasScheme(raw string, schemes ...string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	for _, s := range schemes {
		if u.Scheme == s {
			return true
		}
	}
	return false
}

// loader accumulates validation errors so the operator sees every problem in one run.
type loader struct {
	get  func(string) string
	errs []error
}

func (l *loader) fail(format string, args ...any) {
	l.errs = append(l.errs, fmt.Errorf(format, args...))
}

func (l *loader) err() error { return errors.Join(l.errs...) }

func (l *loader) str(key, def string) string {
	if v := strings.TrimSpace(l.get(key)); v != "" {
		return v
	}
	return def
}

func (l *loader) required(key string) string {
	v := strings.TrimSpace(l.get(key))
	if v == "" {
		l.fail("%s is required", key)
	}
	return v
}

func (l *loader) boolean(key string, def bool) bool {
	v := l.str(key, "")
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		l.fail("%s must be a boolean", key)
		return def
	}
	return b
}

func (l *loader) duration(key string, def time.Duration) time.Duration {
	v := l.str(key, "")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		l.fail("%s must be a duration such as 15m", key)
		return def
	}
	return d
}

func (l *loader) positiveInt(key string, def int) int {
	v := l.str(key, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		l.fail("%s must be a positive integer", key)
		return def
	}
	return n
}
