package domain

import (
	"math"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// ProjectStatus is the lifecycle state of a project.
type ProjectStatus string

// Project statuses.
const (
	ProjectActive   ProjectStatus = "active"
	ProjectFinished ProjectStatus = "finished"
)

// Project limits; the title limit mirrors the schema CHECK.
const (
	MinTitleLen = 1
	MaxTitleLen = 120
)

// Image limits (docs/03-database.md, section 3).
const (
	MaxImageBytes  = 10 << 20   // 10 MiB
	MaxImagePixels = 16_000_000 // 16 megapixels
	// MaxImageSide is the longest side kept after upload; larger images are
	// downscaled by the imaging platform package (iOS canvas limit).
	MaxImageSide = 4096
)

// Project is a ticket-printing project: an image, three text placeholders and
// the participant table.
type Project struct {
	ID           string
	Title        string
	Status       ProjectStatus
	FinishedAt   *time.Time
	Image        *ImageMeta // nil until an image is uploaded
	Placeholders Placeholders
	// NextNumber is the next participant number to hand out. Numbers are never reused.
	NextNumber int
	// Version grows with every write and guards concurrent project edits.
	Version   int
	CreatedBy string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ValidateTitle trims a project title and checks it is 1..120 characters.
func ValidateTitle(raw string) (string, error) {
	title := strings.TrimSpace(raw)
	if n := utf8.RuneCountInString(title); n < MinTitleLen || n > MaxTitleLen {
		return "", fieldError("title", "must be 1-120 characters")
	}
	return title, nil
}

// IsFinished reports whether the project is read-only.
func (p Project) IsFinished() bool { return p.Status == ProjectFinished }

// EnsureWritable is the read-only guard: every write into a finished project
// must call it and propagate ErrProjectFinished.
func (p Project) EnsureWritable() error {
	if p.IsFinished() {
		return ErrProjectFinished
	}
	return nil
}

// Finish returns the project switched to the finished state. Finishing an
// already finished project returns ErrProjectFinished.
func (p Project) Finish(now time.Time) (Project, error) {
	if err := p.EnsureWritable(); err != nil {
		return Project{}, err
	}
	p.Status = ProjectFinished
	p.FinishedAt = &now
	p.Version++
	p.UpdatedAt = now
	return p, nil
}

// Reopen returns the project switched back to active. Reopening a project that
// is not finished is a validation error.
func (p Project) Reopen(now time.Time) (Project, error) {
	if !p.IsFinished() {
		return Project{}, fieldError("status", "project is not finished")
	}
	p.Status = ProjectActive
	p.FinishedAt = nil
	p.Version++
	p.UpdatedAt = now
	return p, nil
}

// ImageMeta describes the stored original image of a project. The bytes live
// in the content-addressed file store, addressed by SHA256.
type ImageMeta struct {
	SHA256 string
	Name   string
	Mime   string
	Width  int
	Height int
	Bytes  int
}

// Thumbnail constants. The preview of an image is stored next to it under the key
// ThumbKey(sha) and lives and dies with the original.
const (
	// BlobThumbSuffix is appended to an image hash to address its preview in the file store.
	BlobThumbSuffix = ".thumb"
	// ThumbSide is the longest side of a preview in pixels.
	ThumbSide = 480
	// MimeThumb is the media type of every preview.
	MimeThumb = "image/jpeg"
)

// ThumbKey returns the file store key of the preview of the image with the given hash.
func ThumbKey(sha string) string { return sha + BlobThumbSuffix }

// allowedImageMimes lists the accepted source image types.
var allowedImageMimes = []string{"image/png", "image/jpeg"}

// Validate checks the metadata and maps problems onto the API error codes:
// ErrUnsupportedMedia, ErrTooLarge and ErrImageInvalid.
func (m ImageMeta) Validate() error {
	if !slices.Contains(allowedImageMimes, m.Mime) {
		return ErrUnsupportedMedia
	}
	if m.Bytes > MaxImageBytes {
		return ErrTooLarge
	}
	if m.Width <= 0 || m.Height <= 0 || m.Bytes <= 0 || !isHex64(m.SHA256) ||
		utf8.RuneCountInString(m.Name) == 0 || utf8.RuneCountInString(m.Name) > 255 {
		return ErrImageInvalid
	}
	// Compare in int64 so the product cannot overflow on 32-bit platforms.
	if int64(m.Width)*int64(m.Height) > MaxImagePixels {
		return ErrImageInvalid
	}
	return nil
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// PlaceholderKey names one of the three text placeholders of a project.
type PlaceholderKey string

// The three placeholder keys.
const (
	PlaceholderNumber PlaceholderKey = "number"
	PlaceholderName   PlaceholderKey = "name"
	PlaceholderPhone  PlaceholderKey = "phone"
)

// PlaceholderKeys lists the keys in display order.
var PlaceholderKeys = []PlaceholderKey{PlaceholderNumber, PlaceholderName, PlaceholderPhone}

// Placeholder limits; they mirror the schema CHECKs.
const (
	MinFontSize = 6
	MaxFontSize = 400
	MaxStroke   = 50
)

// allowedFonts is the font allow-list; fonts are bundled with the frontend.
var allowedFonts = []string{
	"Montserrat", "Roboto", "Open Sans", "Inter", "PT Sans", "Oswald", "Playfair Display", "Arimo",
}

// AllowedFonts returns a copy of the font allow-list.
func AllowedFonts() []string { return slices.Clone(allowedFonts) }

// Placeholder is the text style and position of one ticket field. X and Y are
// pixels of the source image and denote the centre of the rendered text.
type Placeholder struct {
	Font        string
	Size        int
	Stroke      int
	Color       string
	StrokeColor string
	Bold        bool
	Italic      bool
	Underline   bool
	X           int
	Y           int
}

// Validate checks every field. Errors are reported with field names prefixed
// by prefix (for example "placeholders.name").
func (p Placeholder) Validate(prefix string) error {
	var errs []error
	if !slices.Contains(allowedFonts, p.Font) {
		errs = append(errs, fieldError(prefix+".font", "font is not in the allow-list"))
	}
	if p.Size < MinFontSize || p.Size > MaxFontSize {
		errs = append(errs, fieldError(prefix+".size", "must be 6-400"))
	}
	if p.Stroke < 0 || p.Stroke > MaxStroke {
		errs = append(errs, fieldError(prefix+".stroke", "must be 0-50"))
	}
	if err := ValidateColor(prefix+".color", p.Color); err != nil {
		errs = append(errs, err)
	}
	if err := ValidateColor(prefix+".strokeColor", p.StrokeColor); err != nil {
		errs = append(errs, err)
	}
	if p.X < 0 {
		errs = append(errs, fieldError(prefix+".x", "must not be negative"))
	}
	if p.Y < 0 {
		errs = append(errs, fieldError(prefix+".y", "must not be negative"))
	}
	return collect(errs...)
}

// Placeholders holds the three placeholders of a project; a struct (not a map)
// makes a missing key unrepresentable.
type Placeholders struct {
	Number Placeholder
	Name   Placeholder
	Phone  Placeholder
}

// Get returns the placeholder for key; ok is false for an unknown key.
func (ps Placeholders) Get(key PlaceholderKey) (p Placeholder, ok bool) {
	switch key {
	case PlaceholderNumber:
		return ps.Number, true
	case PlaceholderName:
		return ps.Name, true
	case PlaceholderPhone:
		return ps.Phone, true
	}
	return Placeholder{}, false
}

// Validate validates all three placeholders and reports every problem.
func (ps Placeholders) Validate() error {
	return collect(
		ps.Number.Validate("placeholders.number"),
		ps.Name.Validate("placeholders.name"),
		ps.Phone.Validate("placeholders.phone"),
	)
}

// each applies f to a pointer for every placeholder.
func (ps *Placeholders) each(f func(*Placeholder)) {
	f(&ps.Number)
	f(&ps.Name)
	f(&ps.Phone)
}

// fallbackImageW and fallbackImageH are used for default placeholders while a
// project has no image yet.
const (
	fallbackImageW = 1024
	fallbackImageH = 768
)

// DefaultPlaceholders returns sensible initial placeholders for an image of
// the given size: centred horizontally, stacked vertically, with the font size
// proportional to the image height. Non-positive dimensions select a
// 1024x768 canvas.
func DefaultPlaceholders(imageW, imageH int) Placeholders {
	if imageW <= 0 || imageH <= 0 {
		imageW, imageH = fallbackImageW, fallbackImageH
	}
	size := clamp(int(math.Round(float64(imageH)/22.5)), MinFontSize, MaxFontSize)
	stroke := clamp(size/17, 0, MaxStroke)
	style := func(sz, y int) Placeholder {
		return Placeholder{
			Font: "Montserrat", Size: sz, Stroke: stroke,
			Color: "#FFFFFF", StrokeColor: "#141619", Bold: true,
			X: imageW / 2, Y: y,
		}
	}
	return Placeholders{
		Number: style(size, imageH*16/100),
		Name:   style(size, imageH*50/100),
		Phone:  style(clamp(size*85/100, MinFontSize, MaxFontSize), imageH*62/100),
	}
}

// Rescaled returns the placeholders adapted to a replacement image of a
// different size. Positions scale independently per axis; font size and stroke
// scale by the smaller axis factor so text never grows past the new image.
// Results are rounded and clamped to the valid ranges, and kept inside the new
// image bounds.
func (ps Placeholders) Rescaled(oldW, oldH, newW, newH int) (Placeholders, error) {
	if oldW <= 0 || oldH <= 0 || newW <= 0 || newH <= 0 {
		return Placeholders{}, fieldError("image", "image dimensions must be positive")
	}
	ps.each(func(p *Placeholder) {
		p.X = clamp(scaleInt(p.X, newW, oldW), 0, newW)
		p.Y = clamp(scaleInt(p.Y, newH, oldH), 0, newH)
		// Uniform factor = min(newW/oldW, newH/oldH), compared without floats.
		num, den := newW, oldW
		if int64(newH)*int64(oldW) < int64(newW)*int64(oldH) {
			num, den = newH, oldH
		}
		p.Size = clamp(scaleInt(p.Size, num, den), MinFontSize, MaxFontSize)
		p.Stroke = clamp(scaleInt(p.Stroke, num, den), 0, MaxStroke)
	})
	return ps, nil
}

// scaleInt returns round(v*num/den) using 64-bit integer arithmetic.
func scaleInt(v, num, den int) int {
	return int((int64(v)*int64(num) + int64(den)/2) / int64(den))
}

func clamp(v, lo, hi int) int { return min(max(v, lo), hi) }
