package domain

import (
	"bytes"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Uploaded (custom) font limits. They keep the 10 GB production disk and the 2 GB RAM safe: a
// font is read into memory once at upload time.
const (
	MaxFontBytes   = 2 << 20  // 2 MiB per file
	MaxFontsTotal  = 20 << 20 // 20 MiB of uploaded fonts altogether
	MaxFontCount   = 50       // at most this many uploaded fonts
	MaxFontNameLen = 60       // display name, in characters

	// CustomFontPrefix starts Placeholder.Font of an uploaded font: CustomFontPrefix + Font.ID.
	CustomFontPrefix = "custom:"

	FontFormatTTF   = "ttf"
	FontFormatOTF   = "otf"
	FontFormatWOFF2 = "woff2"
)

// Font is an uploaded font file. The bytes live in the content-addressed file store under SHA256.
type Font struct {
	ID        string
	Name      string
	Format    string // FontFormatTTF, FontFormatOTF or FontFormatWOFF2
	SHA256    string
	Bytes     int
	CreatedBy string // empty after the uploader was deleted
	CreatedAt time.Time
}

// FontMime returns the media type served for a font format.
func FontMime(format string) string {
	switch format {
	case FontFormatOTF:
		return "font/otf"
	case FontFormatWOFF2:
		return "font/woff2"
	default:
		return "font/ttf"
	}
}

// DetectFontFormat inspects the magic bytes and returns the format, or "" when the data is not
// a TrueType, OpenType (CFF) or WOFF2 font. The file name is deliberately ignored.
func DetectFontFormat(data []byte) string {
	if len(data) < 12 {
		return ""
	}
	switch {
	case bytes.HasPrefix(data, []byte{0x00, 0x01, 0x00, 0x00}), bytes.HasPrefix(data, []byte("true")):
		return FontFormatTTF
	case bytes.HasPrefix(data, []byte("OTTO")):
		return FontFormatOTF
	case bytes.HasPrefix(data, []byte("wOF2")):
		return FontFormatWOFF2
	}
	return ""
}

// ValidateFontName trims the display name and checks its length and characters.
func ValidateFontName(name string) (string, error) {
	name = strings.TrimSpace(name)
	n := utf8.RuneCountInString(name)
	if n < 1 || n > MaxFontNameLen {
		return "", fieldError("name", "must be 1-60 characters")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", fieldError("name", "must not contain control characters")
		}
	}
	return name, nil
}

var uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// CustomFontRef returns the Placeholder.Font value that selects the uploaded font with the given id.
func CustomFontRef(id string) string { return CustomFontPrefix + id }

// CustomFontID extracts the font id from a Placeholder.Font value; ok is false for built-in fonts
// and for malformed references.
func CustomFontID(font string) (id string, ok bool) {
	rest, found := strings.CutPrefix(font, CustomFontPrefix)
	if !found || !uuidShape.MatchString(rest) {
		return "", false
	}
	return rest, true
}

// IsCustomFont reports whether font has the shape of an uploaded font reference. Whether that
// font exists is checked by the service, which has the repository.
func IsCustomFont(font string) bool {
	_, ok := CustomFontID(font)
	return ok
}
