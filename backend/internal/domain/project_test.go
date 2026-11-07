package domain

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)

func TestValidateTitle(t *testing.T) {
	tests := []struct {
		name, in, want string
		ok             bool
	}{
		{"plain", "Contest", "Contest", true},
		{"trim", "  Contest  ", "Contest", true},
		{"max runes", strings.Repeat("Я", 120), strings.Repeat("Я", 120), true},
		{"too long", strings.Repeat("a", 121), "", false},
		{"empty", "", "", false},
		{"blank", " \t ", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateTitle(tt.in)
			if (err == nil) != tt.ok || got != tt.want {
				t.Fatalf("got (%q, %v)", got, err)
			}
		})
	}
}

func TestProjectLifecycle(t *testing.T) {
	p := Project{ID: "p", Status: ProjectActive, Version: 4}
	if err := p.EnsureWritable(); err != nil {
		t.Fatalf("active project must be writable: %v", err)
	}

	later := t0.Add(time.Hour)
	fin, err := p.Finish(t0)
	if err != nil {
		t.Fatal(err)
	}
	if !fin.IsFinished() || fin.FinishedAt == nil || !fin.FinishedAt.Equal(t0) || fin.Version != 5 || !fin.UpdatedAt.Equal(t0) {
		t.Fatalf("finished = %+v", fin)
	}
	if p.Status != ProjectActive || p.FinishedAt != nil {
		t.Fatal("Finish must not mutate the receiver")
	}
	if err := fin.EnsureWritable(); !errors.Is(err, ErrProjectFinished) {
		t.Fatalf("guard = %v", err)
	}
	if _, err := fin.Finish(later); !errors.Is(err, ErrProjectFinished) {
		t.Fatalf("double finish = %v", err)
	}

	re, err := fin.Reopen(later)
	if err != nil {
		t.Fatal(err)
	}
	if re.Status != ProjectActive || re.FinishedAt != nil || re.Version != 6 || !re.UpdatedAt.Equal(later) {
		t.Fatalf("reopened = %+v", re)
	}
	if _, err := re.Reopen(later); !errors.Is(err, ErrValidation) {
		t.Fatalf("reopen active = %v", err)
	}
}

func TestImageMetaValidate(t *testing.T) {
	good := ImageMeta{SHA256: strings.Repeat("ab", 32), Name: "a.jpg", Mime: "image/jpeg", Width: 1024, Height: 768, Bytes: 2000}
	mut := func(f func(*ImageMeta)) ImageMeta { m := good; f(&m); return m }
	tests := []struct {
		name string
		m    ImageMeta
		want *Error
	}{
		{"ok", good, nil},
		{"png ok", mut(func(m *ImageMeta) { m.Mime = "image/png" }), nil},
		{"exact pixel limit", mut(func(m *ImageMeta) { m.Width, m.Height = 4000, 4000 }), nil},
		{"exact byte limit", mut(func(m *ImageMeta) { m.Bytes = MaxImageBytes }), nil},
		{"gif", mut(func(m *ImageMeta) { m.Mime = "image/gif" }), ErrUnsupportedMedia},
		{"empty mime", mut(func(m *ImageMeta) { m.Mime = "" }), ErrUnsupportedMedia},
		{"too many bytes", mut(func(m *ImageMeta) { m.Bytes = MaxImageBytes + 1 }), ErrTooLarge},
		{"too many pixels", mut(func(m *ImageMeta) { m.Width, m.Height = 4001, 4000 }), ErrImageInvalid},
		{"huge dims no overflow", mut(func(m *ImageMeta) { m.Width, m.Height = 1<<30, 1<<30 }), ErrImageInvalid},
		{"zero width", mut(func(m *ImageMeta) { m.Width = 0 }), ErrImageInvalid},
		{"negative height", mut(func(m *ImageMeta) { m.Height = -1 }), ErrImageInvalid},
		{"zero bytes", mut(func(m *ImageMeta) { m.Bytes = 0 }), ErrImageInvalid},
		{"short sha", mut(func(m *ImageMeta) { m.SHA256 = "abc" }), ErrImageInvalid},
		{"uppercase sha", mut(func(m *ImageMeta) { m.SHA256 = strings.Repeat("AB", 32) }), ErrImageInvalid},
		{"non-hex sha", mut(func(m *ImageMeta) { m.SHA256 = strings.Repeat("zz", 32) }), ErrImageInvalid},
		{"empty name", mut(func(m *ImageMeta) { m.Name = "" }), ErrImageInvalid},
		{"long name", mut(func(m *ImageMeta) { m.Name = strings.Repeat("n", 256) }), ErrImageInvalid},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.m.Validate()
			if tt.want == nil && err != nil {
				t.Fatalf("unexpected: %v", err)
			}
			if tt.want != nil && !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func goodPlaceholder() Placeholder {
	return Placeholder{Font: "Inter", Size: 34, Stroke: 2, Color: "#FFFFFF", StrokeColor: "#141619", X: 10, Y: 20}
}

func TestPlaceholderValidate(t *testing.T) {
	mut := func(f func(*Placeholder)) Placeholder { p := goodPlaceholder(); f(&p); return p }
	tests := []struct {
		name  string
		p     Placeholder
		field string // expected failing field suffix, "" for valid
	}{
		{"valid", goodPlaceholder(), ""},
		{"min size", mut(func(p *Placeholder) { p.Size = 6 }), ""},
		{"max size", mut(func(p *Placeholder) { p.Size = 400 }), ""},
		{"max stroke", mut(func(p *Placeholder) { p.Stroke = 50 }), ""},
		{"origin", mut(func(p *Placeholder) { p.X, p.Y = 0, 0 }), ""},
		{"unknown font", mut(func(p *Placeholder) { p.Font = "Comic Sans" }), "font"},
		{"font case sensitive", mut(func(p *Placeholder) { p.Font = "inter" }), "font"},
		{"size small", mut(func(p *Placeholder) { p.Size = 5 }), "size"},
		{"size big", mut(func(p *Placeholder) { p.Size = 401 }), "size"},
		{"stroke negative", mut(func(p *Placeholder) { p.Stroke = -1 }), "stroke"},
		{"stroke big", mut(func(p *Placeholder) { p.Stroke = 51 }), "stroke"},
		{"color short", mut(func(p *Placeholder) { p.Color = "#fff" }), "color"},
		{"stroke color bad", mut(func(p *Placeholder) { p.StrokeColor = "black" }), "strokeColor"},
		{"x negative", mut(func(p *Placeholder) { p.X = -1 }), "x"},
		{"y negative", mut(func(p *Placeholder) { p.Y = -1 }), "y"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.p.Validate("ph")
			if tt.field == "" {
				if err != nil {
					t.Fatalf("unexpected: %v", err)
				}
				return
			}
			var ve *ValidationError
			if !errors.As(err, &ve) || len(ve.Fields) != 1 || ve.Fields[0].Field != "ph."+tt.field {
				t.Fatalf("err = %v, want field ph.%s", err, tt.field)
			}
		})
	}
}

func TestAllowedFonts(t *testing.T) {
	want := []string{"Montserrat", "Roboto", "Open Sans", "Inter", "PT Sans", "Oswald", "Playfair Display", "Arimo"}
	got := AllowedFonts()
	if !slices.Equal(got, want) {
		t.Fatalf("fonts = %v", got)
	}
	for _, f := range want {
		p := goodPlaceholder()
		p.Font = f
		if err := p.Validate("p"); err != nil {
			t.Errorf("%s rejected: %v", f, err)
		}
	}
	got[0] = "mutated"
	if AllowedFonts()[0] != "Montserrat" {
		t.Fatal("AllowedFonts must return a copy")
	}
}

func TestPlaceholdersValidateAggregates(t *testing.T) {
	ps := Placeholders{Number: goodPlaceholder(), Name: goodPlaceholder(), Phone: goodPlaceholder()}
	if err := ps.Validate(); err != nil {
		t.Fatal(err)
	}
	ps.Name.Size = 1
	ps.Phone.X = -5
	var ve *ValidationError
	err := ps.Validate()
	if !errors.As(err, &ve) || len(ve.Fields) != 2 ||
		ve.Fields[0].Field != "placeholders.name.size" || ve.Fields[1].Field != "placeholders.phone.x" {
		t.Fatalf("err = %v", err)
	}
}

func TestPlaceholdersGet(t *testing.T) {
	ps := Placeholders{Number: Placeholder{Size: 1}, Name: Placeholder{Size: 2}, Phone: Placeholder{Size: 3}}
	for i, k := range PlaceholderKeys {
		p, ok := ps.Get(k)
		if !ok || p.Size != i+1 {
			t.Errorf("Get(%s) = %+v %v", k, p, ok)
		}
	}
	if _, ok := ps.Get("email"); ok {
		t.Error("unknown key must not be found")
	}
	if !slices.Equal(PlaceholderKeys, []PlaceholderKey{"number", "name", "phone"}) {
		t.Error("keys mismatch")
	}
}

func TestDefaultPlaceholders(t *testing.T) {
	tests := []struct {
		name string
		w, h int
	}{
		{"typical", 1024, 768},
		{"portrait", 600, 1800},
		{"tiny", 40, 30},
		{"huge", 4096, 4096},
		{"no image", 0, 0},
		{"negative", -5, 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ps := DefaultPlaceholders(tt.w, tt.h)
			if err := ps.Validate(); err != nil {
				t.Fatalf("defaults must be valid: %v", err)
			}
			w, h := tt.w, tt.h
			if w <= 0 || h <= 0 {
				w, h = 1024, 768
			}
			for _, k := range PlaceholderKeys {
				p, _ := ps.Get(k)
				if p.X != w/2 || p.Y < 0 || p.Y > h {
					t.Errorf("%s position (%d,%d) outside %dx%d", k, p.X, p.Y, w, h)
				}
			}
			if ps.Number.Y >= ps.Name.Y || ps.Name.Y >= ps.Phone.Y {
				t.Errorf("placeholders must be stacked top to bottom: %d %d %d", ps.Number.Y, ps.Name.Y, ps.Phone.Y)
			}
		})
	}
	ps := DefaultPlaceholders(1024, 768)
	if ps.Number.Size != 34 || ps.Number.Stroke != 2 || ps.Number.X != 512 {
		t.Errorf("1024x768 defaults drifted from the documented example: %+v", ps.Number)
	}
}

func TestPlaceholdersRescaled(t *testing.T) {
	base := Placeholders{
		Number: Placeholder{Font: "Inter", Size: 40, Stroke: 4, Color: "#FFFFFF", StrokeColor: "#000000", X: 500, Y: 100},
		Name:   Placeholder{Font: "Inter", Size: 20, Stroke: 0, Color: "#FFFFFF", StrokeColor: "#000000", X: 0, Y: 1000},
		Phone:  Placeholder{Font: "Inter", Size: 8, Stroke: 1, Color: "#FFFFFF", StrokeColor: "#000000", X: 1000, Y: 0},
	}

	t.Run("identity", func(t *testing.T) {
		got, err := base.Rescaled(1000, 1000, 1000, 1000)
		if err != nil || got != base {
			t.Fatalf("got %+v %v", got, err)
		}
	})
	t.Run("uniform halving", func(t *testing.T) {
		got, err := base.Rescaled(1000, 1000, 500, 500)
		if err != nil {
			t.Fatal(err)
		}
		if got.Number.X != 250 || got.Number.Y != 50 || got.Number.Size != 20 || got.Number.Stroke != 2 {
			t.Errorf("number = %+v", got.Number)
		}
		if got.Name.Size != 10 || got.Name.Y != 500 || got.Name.X != 0 {
			t.Errorf("name = %+v", got.Name)
		}
		if got.Phone.Size != MinFontSize { // 8 / 2 = 4, clamped up to 6
			t.Errorf("phone size = %d, want clamp to %d", got.Phone.Size, MinFontSize)
		}
		if err := got.Validate(); err != nil {
			t.Errorf("result must stay valid: %v", err)
		}
	})
	t.Run("anisotropic uses smaller factor for size", func(t *testing.T) {
		got, err := base.Rescaled(1000, 1000, 2000, 500)
		if err != nil {
			t.Fatal(err)
		}
		if got.Number.X != 1000 || got.Number.Y != 50 {
			t.Errorf("position = (%d,%d)", got.Number.X, got.Number.Y)
		}
		if got.Number.Size != 20 { // min(2.0, 0.5) = 0.5
			t.Errorf("size = %d", got.Number.Size)
		}
	})
	t.Run("upscale clamps to maxima", func(t *testing.T) {
		big := Placeholders{Number: Placeholder{Size: 300, Stroke: 40, X: 10, Y: 10, Color: "#000000", StrokeColor: "#000000", Font: "Inter"}}
		got, _ := big.Rescaled(100, 100, 1000, 1000)
		if got.Number.Size != MaxFontSize || got.Number.Stroke != MaxStroke {
			t.Errorf("not clamped: %+v", got.Number)
		}
	})
	t.Run("positions stay inside the new image", func(t *testing.T) {
		got, _ := base.Rescaled(1000, 1000, 100, 100)
		for _, k := range PlaceholderKeys {
			p, _ := got.Get(k)
			if p.X < 0 || p.X > 100 || p.Y < 0 || p.Y > 100 {
				t.Errorf("%s out of bounds: (%d,%d)", k, p.X, p.Y)
			}
		}
	})
	t.Run("receiver untouched", func(t *testing.T) {
		before := base
		_, _ = base.Rescaled(1000, 1000, 10, 10)
		if base != before {
			t.Fatal("Rescaled mutated its receiver")
		}
	})
	t.Run("bad dimensions", func(t *testing.T) {
		for _, d := range [][4]int{{0, 1, 1, 1}, {1, 0, 1, 1}, {1, 1, 0, 1}, {1, 1, 1, -1}} {
			if _, err := base.Rescaled(d[0], d[1], d[2], d[3]); !errors.Is(err, ErrValidation) {
				t.Errorf("dims %v: err = %v", d, err)
			}
		}
	})
}
