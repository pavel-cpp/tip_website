package imaging

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x += 7 {
		img.Set(x, x%h, color.NRGBA{R: 200, A: 255})
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func makeJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestProcessKeepsSmallImageUnchanged(t *testing.T) {
	p := New(0, 0)
	data := makePNG(t, 100, 50)
	got, err := p.Process(data)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.Data, data) || got.Width != 100 || got.Height != 50 || got.Mime != MimePNG {
		t.Fatalf("unexpected result: %dx%d %s", got.Width, got.Height, got.Mime)
	}
	if len(got.SHA256) != 64 {
		t.Fatalf("bad sha %q", got.SHA256)
	}
}

func TestProcessDownscales(t *testing.T) {
	p := New(0, 0)
	p.maxSide = 64
	for name, data := range map[string][]byte{"png": makePNG(t, 200, 100), "jpeg": makeJPEG(t, 100, 200)} {
		t.Run(name, func(t *testing.T) {
			got, err := p.Process(data)
			if err != nil {
				t.Fatal(err)
			}
			if max(got.Width, got.Height) != 64 {
				t.Fatalf("long side = %dx%d", got.Width, got.Height)
			}
			cfg, _, err := image.DecodeConfig(bytes.NewReader(got.Data))
			if err != nil || cfg.Width != got.Width || cfg.Height != got.Height {
				t.Fatalf("re-encoded size mismatch: %v %v", cfg, err)
			}
		})
	}
}

func TestThumbnail(t *testing.T) {
	p := New(0, 0)
	for name, tc := range map[string]struct {
		data         []byte
		wantW, wantH int
	}{
		"large png":   {makePNG(t, 1200, 600), 480, 240},
		"tall jpeg":   {makeJPEG(t, 300, 1500), 96, 480},
		"small image": {makePNG(t, 100, 50), 100, 50},
	} {
		t.Run(name, func(t *testing.T) {
			out, err := p.Thumbnail(tc.data)
			if err != nil {
				t.Fatal(err)
			}
			cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
			if err != nil || format != "jpeg" || cfg.Width != tc.wantW || cfg.Height != tc.wantH {
				t.Fatalf("got %v %s %dx%d, want jpeg %dx%d", err, format, cfg.Width, cfg.Height, tc.wantW, tc.wantH)
			}
		})
	}
	if _, err := p.Thumbnail([]byte("not an image")); !errors.Is(err, domain.ErrUnsupportedMedia) {
		t.Fatalf("garbage: %v", err)
	}
}

func TestFitSide(t *testing.T) {
	if w, h := fitSide(8192, 4096, 4096); w != 4096 || h != 2048 {
		t.Fatalf("got %dx%d", w, h)
	}
	if w, h := fitSide(1, 10000, 4096); w != 1 || h != 4096 {
		t.Fatalf("got %dx%d", w, h)
	}
}

func TestProcessErrors(t *testing.T) {
	p := New(1000, 100*100)
	// A crafted PNG header declaring a huge canvas must be rejected before decoding.
	bomb := makePNG(t, 4, 4)
	binary.BigEndian.PutUint32(bomb[16:], 60000)
	binary.BigEndian.PutUint32(bomb[20:], 60000)

	tests := []struct {
		name string
		data []byte
		want error
	}{
		{"gif magic", []byte("GIF89a....."), domain.ErrUnsupportedMedia},
		{"empty", nil, domain.ErrUnsupportedMedia},
		{"truncated png", makePNG(t, 40, 40)[:40], domain.ErrImageInvalid},
		{"bomb header", bomb, domain.ErrImageInvalid},
		{"too many pixels", makePNG(t, 101, 100), domain.ErrImageInvalid},
		{"too many bytes", append(makePNG(t, 10, 10), make([]byte, 2000)...), domain.ErrTooLarge},
		{"garbage jpeg", []byte{0xFF, 0xD8, 0xFF, 1, 2, 3, 4}, domain.ErrImageInvalid},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := p.Process(tc.data); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestAvatar(t *testing.T) {
	p := New(0, 0)
	for name, data := range map[string][]byte{"wide": makePNG(t, 600, 200), "tall": makeJPEG(t, 100, 500), "tiny": makePNG(t, 10, 10)} {
		t.Run(name, func(t *testing.T) {
			out, sha, err := p.Avatar(data)
			if err != nil {
				t.Fatal(err)
			}
			if len(out) > MaxAvatarBytes || len(sha) != 64 {
				t.Fatalf("len=%d sha=%q", len(out), sha)
			}
			img, format, err := image.Decode(bytes.NewReader(out))
			if err != nil || format != "jpeg" {
				t.Fatalf("decode: %v %s", err, format)
			}
			if b := img.Bounds(); b.Dx() != AvatarSize || b.Dy() != AvatarSize {
				t.Fatalf("size %v", b)
			}
		})
	}
	if _, _, err := p.Avatar([]byte("nope")); !errors.Is(err, domain.ErrUnsupportedMedia) {
		t.Fatalf("got %v", err)
	}
}
