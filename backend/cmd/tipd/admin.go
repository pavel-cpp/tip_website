package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/config"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/metrics"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/security"
)

// adminPasswordEnv names the variable that supplies the password for the admin commands; when
// it is unset a temporary password is generated and printed once.
const adminPasswordEnv = "TIP_ADMIN_PASSWORD"

const adminUsage = "usage: tipd admin <create|reset-password> <login>"

// adminCommand implements "tipd admin create <login>" and "tipd admin reset-password <login>".
func adminCommand(args []string, getenv func(string) string, out io.Writer) error {
	if len(args) != 2 || (args[0] != "create" && args[0] != "reset-password") {
		return errors.New(adminUsage)
	}
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	// Only warnings and errors: the command prints a password and must not drown it in logs.
	logger, closeLog := logging.New(logging.Options{Level: "warn", Out: os.Stderr})
	defer func() { _ = closeLog() }()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a, err := newApp(ctx, cfg, logger, metrics.New(version, commit))
	if err != nil {
		return err
	}
	defer a.Close()

	if args[0] == "create" {
		return a.adminCreate(ctx, args[1], getenv(adminPasswordEnv), out)
	}
	return a.adminResetPassword(ctx, args[1], getenv(adminPasswordEnv), out)
}

// adminCreate creates an administrator. An operator-supplied password is permanent; a
// generated one is temporary, so the first login forces a change.
func (a *app) adminCreate(ctx context.Context, rawLogin, password string, out io.Writer) error {
	login, err := domain.NormalizeLogin(rawLogin)
	if err != nil {
		return err
	}
	if _, err := a.userRepo.GetByLogin(ctx, login); err == nil {
		return fmt.Errorf("user %q already exists; use reset-password", login)
	} else if !errors.Is(err, domain.ErrNotFound) {
		return fmt.Errorf("look up user: %w", err)
	}
	generated := password == ""
	if generated {
		if password, err = security.GeneratePassword(); err != nil {
			return err
		}
	}
	if _, err := a.users.EnsureAdmin(ctx, login, password); err != nil {
		return err
	}
	rec, err := a.userRepo.GetByLogin(ctx, login)
	if err != nil {
		return fmt.Errorf("reload user: %w", err)
	}
	if generated {
		if err := a.storePassword(ctx, rec.ID, password, true); err != nil {
			return err
		}
	}
	_ = a.accounts.Record(ctx, domain.AccountAuditEntry{Action: "user.create", TargetID: rec.ID, Meta: map[string]any{"via": "cli"}})
	return printCredentials(out, login, password, generated)
}

// adminResetPassword replaces the password of an existing user and revokes the user's tokens.
func (a *app) adminResetPassword(ctx context.Context, rawLogin, password string, out io.Writer) error {
	login, err := domain.NormalizeLogin(rawLogin)
	if err != nil {
		return err
	}
	rec, err := a.userRepo.GetByLogin(ctx, login)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return fmt.Errorf("user %q not found", login)
		}
		return fmt.Errorf("look up user: %w", err)
	}
	generated := password == ""
	if generated {
		if password, err = security.GeneratePassword(); err != nil {
			return err
		}
	} else if err := domain.ValidatePassword("password", password); err != nil {
		return err
	}
	if err := a.storePassword(ctx, rec.ID, password, generated); err != nil {
		return err
	}
	cutoff := time.Now().UTC().Truncate(time.Millisecond)
	if err := a.tokens.SetUserCutoff(ctx, rec.ID, cutoff, a.cfg.RefreshTokenTTL+time.Minute); err != nil {
		return fmt.Errorf("revoke tokens (the password was changed): %w", err)
	}
	_ = a.accounts.Record(ctx, domain.AccountAuditEntry{Action: "password.reset", TargetID: rec.ID, Meta: map[string]any{"via": "cli"}})
	return printCredentials(out, login, password, generated)
}

func (a *app) storePassword(ctx context.Context, userID, password string, temporary bool) error {
	hash, err := a.hasher.Hash(ctx, password)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	if err := a.userRepo.SetPassword(ctx, userID, hash, temporary); err != nil {
		return fmt.Errorf("store password: %w", err)
	}
	return nil
}

// printCredentials shows a generated password exactly once; a supplied one is never echoed.
func printCredentials(out io.Writer, login, password string, generated bool) error {
	var err error
	if generated {
		_, err = fmt.Fprintf(out, "login: %s\ntemporary password: %s\nThe password is shown once; the user must change it at the first login.\n", login, password)
	} else {
		_, err = fmt.Fprintf(out, "login: %s\npassword set from %s\n", login, adminPasswordEnv)
	}
	return err
}
