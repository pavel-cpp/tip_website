package domain

import (
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Locale is a UI language.
type Locale string

// Theme is a UI colour theme.
type Theme string

// Supported locales and themes.
const (
	LocaleRU Locale = "ru"
	LocaleUZ Locale = "uz"

	ThemeDark   Theme = "dark"
	ThemeLight  Theme = "light"
	ThemeSystem Theme = "system"
)

// Defaults applied to new users; they match the column defaults in the schema.
const (
	DefaultColor  = "#6cb4ff"
	DefaultLocale = LocaleRU
	DefaultTheme  = ThemeDark
)

// Field length limits; they mirror the CHECK constraints in the schema.
const (
	MaxDisplayNameLen = 80
)

var (
	loginPattern = regexp.MustCompile(`^[a-z0-9._-]{3,32}$`)
	// colorPattern accepts #RRGGBB in either letter case, like the schema CHECKs.
	colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// RoleRef is a short reference to a role, embedded in User.
type RoleRef struct {
	ID   string
	Name string
}

// User is an account. The password hash never leaves the repository layer and
// is deliberately not a field here.
type User struct {
	ID                string
	Login             string
	DisplayName       string
	Color             string
	Locale            Locale
	Theme             Theme
	PasswordTemporary bool
	IsActive          bool
	Roles             []RoleRef
	LastLoginAt       *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// IsAdmin reports whether the user holds the system admin role.
func (u User) IsAdmin() bool {
	for _, r := range u.Roles {
		if r.Name == RoleAdmin {
			return true
		}
	}
	return false
}

// NormalizeLogin trims and lower-cases a login and validates it against
// ^[a-z0-9._-]{3,32}$. Logins are stored lower-case, so lookups are case-insensitive.
func NormalizeLogin(raw string) (string, error) {
	login := strings.ToLower(strings.TrimSpace(raw))
	if !loginPattern.MatchString(login) {
		return "", fieldError("login", "must be 3-32 characters of a-z, 0-9, '.', '_' or '-'")
	}
	return login, nil
}

// NormalizeDisplayName trims a display name and checks it is 1..80 characters
// without control characters.
func NormalizeDisplayName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(name)
	if n < 1 || n > MaxDisplayNameLen {
		return "", fieldError("displayName", "must be 1-80 characters")
	}
	if strings.ContainsFunc(name, unicode.IsControl) {
		return "", fieldError("displayName", "must not contain control characters")
	}
	return name, nil
}

// ValidateColor checks a #RRGGBB colour for the named field.
func ValidateColor(field, color string) error {
	if !colorPattern.MatchString(color) {
		return fieldError(field, "must be a #RRGGBB colour")
	}
	return nil
}

// ParseLocale validates a locale code.
func ParseLocale(raw string) (Locale, error) {
	switch l := Locale(raw); l {
	case LocaleRU, LocaleUZ:
		return l, nil
	}
	return "", fieldError("locale", "must be one of: ru, uz")
}

// ParseTheme validates a theme name.
func ParseTheme(raw string) (Theme, error) {
	switch t := Theme(raw); t {
	case ThemeDark, ThemeLight, ThemeSystem:
		return t, nil
	}
	return "", fieldError("theme", "must be one of: dark, light, system")
}

// EnsureAdminRemains enforces the "last admin" invariant: an operation that
// removes `losing` users from a pool of `activeAdmins` active administrators
// (deactivation, role removal) must leave at least one. It returns
// ErrLastAdmin otherwise. Operations that remove nobody always pass.
func EnsureAdminRemains(activeAdmins, losing int) error {
	if losing > 0 && activeAdmins-losing < 1 {
		return ErrLastAdmin
	}
	return nil
}
