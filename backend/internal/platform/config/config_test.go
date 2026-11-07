package config

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

const (
	secA = "0123456789abcdef0123456789abcdef"
	secB = "fedcba9876543210fedcba9876543210"
)

func baseEnv() map[string]string {
	return map[string]string{
		"DATABASE_URL":       "postgres://u:p@localhost:5432/tip",
		"REDIS_URL":          "redis://:pw@localhost:6379/0",
		"JWT_ACCESS_SECRET":  secA,
		"JWT_REFRESH_SECRET": secB,
		"PASSWORD_PEPPER":    secA + "x",
	}
}

func load(env map[string]string) (Config, error) {
	return Load(func(k string) string { return env[k] })
}

func TestLoadDefaults(t *testing.T) {
	c, err := load(baseEnv())
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != ":8080" || c.InternalAddr != ":9090" || !c.AutoMigrate || c.DataDir != "/data" {
		t.Errorf("unexpected defaults: %v", c)
	}
	if c.AccessTokenTTL != 15*time.Minute || c.RefreshTokenTTL != 720*time.Hour {
		t.Errorf("unexpected ttl: %v %v", c.AccessTokenTTL, c.RefreshTokenTTL)
	}
	if c.RedisFailMode != FailOpen || !c.SwaggerEnabled || c.ForcePasswordChange {
		t.Errorf("unexpected flags: %v", c)
	}
	if c.MaxImageMB != 10 || c.MaxImagePixels != 16000000 || c.MinFreeDiskMB != 1024 ||
		c.UploadsMaxTotalMB != 800 || c.AuditRetentionDays != 30 || c.AuditMaxRows != 100000 ||
		c.LogLevel != "info" || c.ObsRetentionDays != 3 {
		t.Errorf("unexpected limits: %v", c)
	}
}

func TestLoadOverrides(t *testing.T) {
	env := baseEnv()
	env["ALLOWED_ORIGINS"] = " https://a.example , https://b.example,"
	env["REDIS_FAIL_MODE"] = "closed"
	env["AUTO_MIGRATE"] = "false"
	env["ACCESS_TOKEN_TTL"] = "5m"
	env["BOOTSTRAP_ADMIN_LOGIN"] = "root"
	env["BOOTSTRAP_ADMIN_PASSWORD"] = "longenough"
	c, err := load(env)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.AllowedOrigins) != 2 || c.RedisFailMode != FailClosed || c.AutoMigrate || c.AccessTokenTTL != 5*time.Minute {
		t.Errorf("overrides not applied: %v", c)
	}
}

func TestLoadErrors(t *testing.T) {
	tests := []struct {
		name string
		mut  func(map[string]string)
		want string
	}{
		{"missing database", func(e map[string]string) { delete(e, "DATABASE_URL") }, "DATABASE_URL is required"},
		{"missing redis", func(e map[string]string) { delete(e, "REDIS_URL") }, "REDIS_URL is required"},
		{"short access secret", func(e map[string]string) { e["JWT_ACCESS_SECRET"] = "short" }, "JWT_ACCESS_SECRET must be at least 32"},
		{"short pepper", func(e map[string]string) { e["PASSWORD_PEPPER"] = "short" }, "PASSWORD_PEPPER must be at least 32"},
		{"equal secrets", func(e map[string]string) { e["JWT_REFRESH_SECRET"] = secA }, "must differ"},
		{"bad fail mode", func(e map[string]string) { e["REDIS_FAIL_MODE"] = "maybe" }, "REDIS_FAIL_MODE"},
		{"bad bool", func(e map[string]string) { e["AUTO_MIGRATE"] = "perhaps" }, "AUTO_MIGRATE must be a boolean"},
		{"bad duration", func(e map[string]string) { e["ACCESS_TOKEN_TTL"] = "soon" }, "ACCESS_TOKEN_TTL"},
		{"refresh shorter", func(e map[string]string) { e["REFRESH_TOKEN_TTL"] = "1m" }, "REFRESH_TOKEN_TTL must exceed"},
		{"bad int", func(e map[string]string) { e["MAX_IMAGE_MB"] = "-1" }, "MAX_IMAGE_MB"},
		{"bad level", func(e map[string]string) { e["LOG_LEVEL"] = "loud" }, "LOG_LEVEL"},
		{"half bootstrap", func(e map[string]string) { e["BOOTSTRAP_ADMIN_LOGIN"] = "root" }, "must be set together"},
		{"bad db scheme", func(e map[string]string) { e["DATABASE_URL"] = "mysql://x" }, "DATABASE_URL must be"},
		{"bad redis scheme", func(e map[string]string) { e["REDIS_URL"] = "http://x" }, "REDIS_URL must be"},
		{"retention too long", func(e map[string]string) { e["OBS_RETENTION_DAYS"] = "9" }, "OBS_RETENTION_DAYS"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := baseEnv()
			tt.mut(env)
			_, err := load(env)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("want error containing %q, got %v", tt.want, err)
			}
		})
	}
}

func TestSecretsAreRedacted(t *testing.T) {
	c, err := load(baseEnv())
	if err != nil {
		t.Fatal(err)
	}
	for _, out := range []string{c.String(), fmt.Sprintf("%v", c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c.JWTAccessSecret)} {
		for _, leak := range []string{secA, secB, "pw@", "u:p@"} {
			if strings.Contains(out, leak) {
				t.Errorf("output leaks %q: %s", leak, out)
			}
		}
	}
	if c.JWTAccessSecret.Reveal() != secA {
		t.Error("Reveal must return the raw value")
	}
}
