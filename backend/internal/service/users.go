package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// MaxAvatarUpload is the largest accepted avatar upload.
const MaxAvatarUpload = 2 << 20

// maxStoredAvatar mirrors the CHECK constraint of user_avatars.
const maxStoredAvatar = 256 << 10

// Profile is a user together with the data the API shows next to it.
type Profile struct {
	User        domain.User
	Permissions []domain.Permission
	// AvatarSHA is empty when the user has no avatar.
	AvatarSHA string
}

// ProfileOf converts a stored user to a Profile, dropping the password hash.
func ProfileOf(r domain.UserRecord) Profile {
	return Profile{User: r.User, Permissions: r.Permissions, AvatarSHA: r.AvatarSHA}
}

// UsersDeps are the collaborators of Users.
type UsersDeps struct {
	Users   UserStore
	Avatars AvatarStore
	Roles   RoleStore
	Authz   AuthzState
	Epoch   *Epoch
	Tx      Tx
	// Tokens may be nil (the "tipd admin" CLI without Redis); revocation is then skipped.
	Tokens     TokenStore
	Hasher     PasswordHasher
	Passwords  PasswordGenerator
	Images     ImageProcessor
	Audit      Audit
	Clock      Clock
	IDs        IDGen
	RefreshTTL time.Duration
	// OnUserRevoked is called after a user's tokens were invalidated (deactivation, password
	// reset) so the realtime hub can close that user's sockets. It must not block.
	OnUserRevoked func(userID string)
	// OnTokenStoreError receives the underlying error when the token store fails.
	OnTokenStoreError func(op string, err error)
}

// Users implements the profile and the user administration use cases.
type Users struct {
	UsersDeps
}

// NewUsers builds the users service.
func NewUsers(d UsersDeps) *Users { return &Users{UsersDeps: d} }

func (s *Users) audit(ctx context.Context, e domain.AuditEntry) error {
	if s.Audit == nil {
		return nil
	}
	if err := s.Audit.Record(ctx, e); err != nil {
		return fmt.Errorf("record audit %s: %w", e.Action, err)
	}
	return nil
}

func (s *Users) load(ctx context.Context, id string) (domain.UserRecord, error) {
	rec, err := s.Users.GetByID(ctx, id)
	if err != nil {
		return domain.UserRecord{}, fmt.Errorf("load user: %w", err)
	}
	return rec, nil
}

// revoke invalidates every token of the user issued so far.
func (s *Users) revoke(ctx context.Context, userID string) error {
	if s.Tokens == nil {
		return nil
	}
	cutoff := s.Clock.Now().Truncate(time.Millisecond)
	if err := s.Tokens.SetUserCutoff(ctx, userID, cutoff, s.RefreshTTL+cutoffTTLSlack); err != nil {
		if s.OnTokenStoreError != nil {
			s.OnTokenStoreError("revoke_user", err)
		}
		return domain.ErrAuthUnavailable
	}
	return nil
}

func (s *Users) revoked(userID string) {
	if s.OnUserRevoked != nil {
		s.OnUserRevoked(userID)
	}
}

// Me returns the caller's own profile.
func (s *Users) Me(ctx context.Context, actor domain.Actor) (Profile, error) {
	rec, err := s.load(ctx, actor.UserID)
	if errors.Is(err, domain.ErrNotFound) {
		return Profile{}, domain.ErrUnauthenticated
	}
	if err != nil {
		return Profile{}, err
	}
	return ProfileOf(rec), nil
}

// ProfileUpdate lists the profile fields to change (nil leaves a field as is).
type ProfileUpdate struct {
	DisplayName *string
	Color       *string
	Locale      *string
	Theme       *string
}

// UpdateProfile changes the caller's own profile (the implicit profile.edit right).
func (s *Users) UpdateProfile(ctx context.Context, actor domain.Actor, in ProfileUpdate) (Profile, error) {
	var patch domain.ProfilePatch
	var errs []error
	if in.DisplayName != nil {
		n, err := domain.NormalizeDisplayName(*in.DisplayName)
		errs, patch.DisplayName = append(errs, err), &n
	}
	if in.Color != nil {
		errs = append(errs, domain.ValidateColor("color", *in.Color))
		patch.Color = in.Color
	}
	if in.Locale != nil {
		l, err := domain.ParseLocale(*in.Locale)
		errs, patch.Locale = append(errs, err), &l
	}
	if in.Theme != nil {
		t, err := domain.ParseTheme(*in.Theme)
		errs, patch.Theme = append(errs, err), &t
	}
	if err := joinValidation(errs...); err != nil {
		return Profile{}, err
	}
	if err := s.Users.UpdateProfile(ctx, actor.UserID, patch); err != nil {
		return Profile{}, fmt.Errorf("update profile: %w", err)
	}
	return s.Me(ctx, actor)
}

// joinValidation merges validation errors; nil when none failed.
func joinValidation(errs ...error) error {
	var fields []domain.FieldError
	for _, err := range errs {
		var ve *domain.ValidationError
		if errors.As(err, &ve) {
			fields = append(fields, ve.Fields...)
		}
	}
	if len(fields) == 0 {
		return nil
	}
	return domain.NewValidation(fields...)
}

// SetAvatar stores a new avatar for the caller after the image processor normalized it.
func (s *Users) SetAvatar(ctx context.Context, actor domain.Actor, raw []byte) (Profile, error) {
	if len(raw) == 0 {
		return Profile{}, domain.NewValidation(domain.FieldError{Field: "file", Reason: "is required"})
	}
	if len(raw) > MaxAvatarUpload {
		return Profile{}, domain.ErrTooLarge
	}
	mime, data, err := s.Images.ProcessAvatar(ctx, raw)
	if err != nil {
		return Profile{}, err
	}
	if len(data) > maxStoredAvatar {
		return Profile{}, domain.ErrTooLarge
	}
	sum := sha256.Sum256(data)
	av := domain.Avatar{MIME: mime, Data: data, SHA256: hex.EncodeToString(sum[:])}
	if err := s.Avatars.PutAvatar(ctx, actor.UserID, av, s.Clock.Now()); err != nil {
		return Profile{}, fmt.Errorf("store avatar: %w", err)
	}
	return s.Me(ctx, actor)
}

// DeleteAvatar removes the caller's avatar.
func (s *Users) DeleteAvatar(ctx context.Context, actor domain.Actor) (Profile, error) {
	if err := s.Avatars.DeleteAvatar(ctx, actor.UserID); err != nil {
		return Profile{}, fmt.Errorf("delete avatar: %w", err)
	}
	return s.Me(ctx, actor)
}

// Avatar returns the avatar of any user; any signed-in user may read it.
func (s *Users) Avatar(ctx context.Context, userID string) (domain.Avatar, error) {
	av, err := s.Avatars.GetAvatar(ctx, userID)
	if err != nil {
		return domain.Avatar{}, err
	}
	return av, nil
}

// List returns all users (user.view).
func (s *Users) List(ctx context.Context, actor domain.Actor) ([]Profile, error) {
	if err := actor.Require(domain.PermUserView); err != nil {
		return nil, err
	}
	recs, err := s.Users.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	out := make([]Profile, len(recs))
	for i, r := range recs {
		out[i] = ProfileOf(r)
	}
	return out, nil
}

// CreateUserInput is the request to create a user. RoleIDs nil means "default role".
type CreateUserInput struct {
	Login       string
	DisplayName string
	Color       string
	RoleIDs     []string
	IP          string
}

// CreatedUser is a new user with the one-time temporary password.
type CreatedUser struct {
	Profile      Profile
	TempPassword string
}

// CreateUser creates an account with a server-generated temporary password (user.manage).
// Choosing roles additionally requires role.manage; otherwise the worker role is assigned.
func (s *Users) CreateUser(ctx context.Context, actor domain.Actor, in CreateUserInput) (CreatedUser, error) {
	if err := actor.Require(domain.PermUserManage); err != nil {
		return CreatedUser{}, err
	}
	if in.RoleIDs != nil {
		if err := actor.Require(domain.PermRoleManage); err != nil {
			return CreatedUser{}, err
		}
	}
	login, loginErr := domain.NormalizeLogin(in.Login)
	name, nameErr := domain.NormalizeDisplayName(in.DisplayName)
	color := in.Color
	var colorErr error
	if color == "" {
		color = domain.DefaultColor
	} else {
		colorErr = domain.ValidateColor("color", color)
	}
	if err := joinValidation(loginErr, nameErr, colorErr); err != nil {
		return CreatedUser{}, err
	}

	var out CreatedUser
	err := s.Tx.Do(ctx, func(ctx context.Context) error {
		roleIDs, err := s.resolveRoleIDs(ctx, in.RoleIDs)
		if err != nil {
			return err
		}
		temp, err := s.Passwords.NewPassword()
		if err != nil {
			return fmt.Errorf("generate password: %w", err)
		}
		hash, err := s.Hasher.Hash(ctx, temp)
		if err != nil {
			return fmt.Errorf("hash password: %w", err)
		}
		id := s.IDs.NewID()
		if err := s.Users.Create(ctx, domain.NewUser{
			ID: id, Login: login, DisplayName: name, Color: color,
			PasswordHash: hash, PasswordTemporary: true, CreatedAt: s.Clock.Now(),
		}); err != nil {
			return err
		}
		if err := s.Users.SetRoles(ctx, id, roleIDs); err != nil {
			return fmt.Errorf("assign roles: %w", err)
		}
		rec, err := s.load(ctx, id)
		if err != nil {
			return err
		}
		out = CreatedUser{Profile: ProfileOf(rec), TempPassword: temp}
		return s.audit(ctx, domain.AuditEntry{Action: "user.create", ActorID: actor.UserID, TargetID: id, IP: in.IP,
			Meta: map[string]any{"roleIds": roleIDs}})
	})
	if err != nil {
		return CreatedUser{}, err
	}
	return out, nil
}

// resolveRoleIDs validates explicit role ids or picks the default worker role.
func (s *Users) resolveRoleIDs(ctx context.Context, requested []string) ([]string, error) {
	if requested == nil {
		w, err := s.Roles.GetByName(ctx, domain.RoleWorker)
		if err != nil {
			return nil, fmt.Errorf("find default role: %w", err)
		}
		return []string{w.ID}, nil
	}
	ids := dedupe(requested)
	if len(ids) == 0 {
		return nil, domain.NewValidation(domain.FieldError{Field: "roleIds", Reason: "at least one role is required"})
	}
	found, err := s.Roles.GetMany(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("load roles: %w", err)
	}
	if len(found) != len(ids) {
		return nil, domain.NewValidation(domain.FieldError{Field: "roleIds", Reason: "unknown role"})
	}
	return ids, nil
}

func dedupe(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// UserUpdate lists the admin-editable fields (nil leaves a field as is).
type UserUpdate struct {
	DisplayName *string
	IsActive    *bool
}

// UpdateUser edits a user or (de)activates the account (user.manage). Deactivation revokes the
// user's tokens at once and may not remove the last administrator.
func (s *Users) UpdateUser(ctx context.Context, actor domain.Actor, id string, in UserUpdate) (Profile, error) {
	if err := actor.Require(domain.PermUserManage); err != nil {
		return Profile{}, err
	}
	var name *string
	if in.DisplayName != nil {
		n, err := domain.NormalizeDisplayName(*in.DisplayName)
		if err != nil {
			return Profile{}, err
		}
		name = &n
	}
	var out Profile
	deactivated := false
	err := s.Tx.Do(ctx, func(ctx context.Context) error {
		rec, err := s.load(ctx, id)
		if err != nil {
			return err
		}
		if name != nil && *name != rec.DisplayName {
			if err := s.Users.UpdateProfile(ctx, id, domain.ProfilePatch{DisplayName: name}); err != nil {
				return fmt.Errorf("update user: %w", err)
			}
		}
		if in.IsActive != nil && *in.IsActive != rec.IsActive {
			if !*in.IsActive {
				if id == actor.UserID {
					return domain.NewValidation(domain.FieldError{Field: "isActive", Reason: "you cannot deactivate yourself"})
				}
				if rec.IsAdmin() {
					n, err := s.Users.CountActiveAdmins(ctx)
					if err != nil {
						return fmt.Errorf("count admins: %w", err)
					}
					if err := domain.EnsureAdminRemains(n, 1); err != nil {
						return err
					}
				}
			}
			if err := s.Users.SetActive(ctx, id, *in.IsActive); err != nil {
				return fmt.Errorf("set active: %w", err)
			}
			action := "user.activate"
			if !*in.IsActive {
				action, deactivated = "user.deactivate", true
				if err := s.revoke(ctx, id); err != nil {
					return err
				}
			}
			if err := s.audit(ctx, domain.AuditEntry{Action: action, ActorID: actor.UserID, TargetID: id}); err != nil {
				return err
			}
		}
		if name != nil && *name != rec.DisplayName {
			if err := s.audit(ctx, domain.AuditEntry{Action: "user.update", ActorID: actor.UserID, TargetID: id}); err != nil {
				return err
			}
		}
		updated, err := s.load(ctx, id)
		out = ProfileOf(updated)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	if deactivated {
		s.revoked(id)
	}
	return out, nil
}

// SetRoles replaces the roles of a user (role.manage), bumps the permission epoch so existing
// tokens are refreshed, and keeps at least one active administrator.
func (s *Users) SetRoles(ctx context.Context, actor domain.Actor, id string, roleIDs []string) (Profile, error) {
	if err := actor.Require(domain.PermRoleManage); err != nil {
		return Profile{}, err
	}
	var out Profile
	var epoch int64
	err := s.Tx.Do(ctx, func(ctx context.Context) error {
		if roleIDs == nil {
			return domain.NewValidation(domain.FieldError{Field: "roleIds", Reason: "is required"})
		}
		ids, err := s.resolveRoleIDs(ctx, roleIDs)
		if err != nil {
			return err
		}
		rec, err := s.load(ctx, id)
		if err != nil {
			return err
		}
		newRoles, err := s.Roles.GetMany(ctx, ids)
		if err != nil {
			return fmt.Errorf("load roles: %w", err)
		}
		if rec.IsActive && rec.IsAdmin() && !slices.ContainsFunc(newRoles, func(r domain.Role) bool { return r.IsAdminRole() }) {
			n, err := s.Users.CountActiveAdmins(ctx)
			if err != nil {
				return fmt.Errorf("count admins: %w", err)
			}
			if err := domain.EnsureAdminRemains(n, 1); err != nil {
				return err
			}
		}
		if err := s.Users.SetRoles(ctx, id, ids); err != nil {
			return fmt.Errorf("assign roles: %w", err)
		}
		if epoch, err = s.Authz.BumpEpoch(ctx); err != nil {
			return fmt.Errorf("bump permission epoch: %w", err)
		}
		before := make([]string, len(rec.Roles))
		for i, r := range rec.Roles {
			before[i] = r.ID
		}
		if err := s.audit(ctx, domain.AuditEntry{Action: "user.roles.set", ActorID: actor.UserID, TargetID: id,
			Meta: map[string]any{"added": difference(ids, before), "removed": difference(before, ids)}}); err != nil {
			return err
		}
		updated, err := s.load(ctx, id)
		out = ProfileOf(updated)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	s.Epoch.Set(epoch)
	return out, nil
}

// difference returns the members of a that are not in b.
func difference(a, b []string) []string {
	out := []string{}
	for _, v := range a {
		if !slices.Contains(b, v) {
			out = append(out, v)
		}
	}
	return out
}

// ResetPassword issues a new temporary password for a user (user.manage) and revokes the
// user's tokens. The password is returned once.
func (s *Users) ResetPassword(ctx context.Context, actor domain.Actor, id string) (string, error) {
	if err := actor.Require(domain.PermUserManage); err != nil {
		return "", err
	}
	temp, err := s.Passwords.NewPassword()
	if err != nil {
		return "", fmt.Errorf("generate password: %w", err)
	}
	hash, err := s.Hasher.Hash(ctx, temp)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	err = s.Tx.Do(ctx, func(ctx context.Context) error {
		if _, err := s.load(ctx, id); err != nil {
			return err
		}
		if err := s.Users.SetPassword(ctx, id, hash, true); err != nil {
			return fmt.Errorf("store password: %w", err)
		}
		if err := s.revoke(ctx, id); err != nil {
			return err
		}
		return s.audit(ctx, domain.AuditEntry{Action: "password.reset", ActorID: actor.UserID, TargetID: id})
	})
	if err != nil {
		return "", err
	}
	s.revoked(id)
	return temp, nil
}

// EnsureAdmin creates the administrator `login` with the given password, or, when the account
// exists, resets its password, reactivates it and makes sure it holds the admin role. It backs
// "tipd admin create" and BOOTSTRAP_ADMIN_*. The password is operator supplied, so it is not
// marked temporary.
func (s *Users) EnsureAdmin(ctx context.Context, login, password string) (created bool, err error) {
	login, loginErr := domain.NormalizeLogin(login)
	if err := joinValidation(loginErr, domain.ValidatePassword("password", password)); err != nil {
		return false, err
	}
	hash, err := s.Hasher.Hash(ctx, password)
	if err != nil {
		return false, fmt.Errorf("hash password: %w", err)
	}
	var userID string
	var epoch int64
	err = s.Tx.Do(ctx, func(ctx context.Context) error {
		admin, err := s.Roles.GetByName(ctx, domain.RoleAdmin)
		if err != nil {
			return fmt.Errorf("find admin role: %w", err)
		}
		rec, err := s.Users.GetByLogin(ctx, login)
		switch {
		case errors.Is(err, domain.ErrNotFound):
			userID = s.IDs.NewID()
			created = true
			if err := s.Users.Create(ctx, domain.NewUser{
				ID: userID, Login: login, DisplayName: login, Color: domain.DefaultColor,
				PasswordHash: hash, PasswordTemporary: false, CreatedAt: s.Clock.Now(),
			}); err != nil {
				return err
			}
			return s.Users.SetRoles(ctx, userID, []string{admin.ID})
		case err != nil:
			return fmt.Errorf("find user: %w", err)
		}
		userID = rec.ID
		if err := s.Users.SetPassword(ctx, rec.ID, hash, false); err != nil {
			return fmt.Errorf("store password: %w", err)
		}
		if !rec.IsActive {
			if err := s.Users.SetActive(ctx, rec.ID, true); err != nil {
				return fmt.Errorf("activate user: %w", err)
			}
		}
		if !rec.IsAdmin() {
			ids := []string{admin.ID}
			for _, r := range rec.Roles {
				ids = append(ids, r.ID)
			}
			if err := s.Users.SetRoles(ctx, rec.ID, ids); err != nil {
				return fmt.Errorf("assign admin role: %w", err)
			}
			if epoch, err = s.Authz.BumpEpoch(ctx); err != nil {
				return fmt.Errorf("bump permission epoch: %w", err)
			}
		}
		return s.revoke(ctx, rec.ID)
	})
	if err != nil {
		return false, err
	}
	if epoch > 0 && s.Epoch != nil {
		s.Epoch.Set(epoch)
	}
	if !created {
		s.revoked(userID)
	}
	return created, nil
}
