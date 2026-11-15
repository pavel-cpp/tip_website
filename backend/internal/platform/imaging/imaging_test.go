package imaging

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/gate"
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
			out, sha, err := p.Avatar(context.Background(), data)
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
	if _, _, err := p.Avatar(context.Background(), []byte("nope")); !errors.Is(err, domain.ErrUnsupportedMedia) {
		t.Fatalf("got %v", err)
	}
}

// pngChunk builds one PNG chunk with a valid CRC.
func pngChunk(typ string, payload []byte) []byte {
	b := binary.BigEndian.AppendUint32(nil, uint32(len(payload)))
	b = append(b, typ...)
	b = append(b, payload...)
	return binary.BigEndian.AppendUint32(b, crc32.ChecksumIEEE(b[4:]))
}

// bombPNG hand-writes a PNG that declares a w x h canvas but carries no pixel data, so a decoder
// that trusted the header would allocate the whole canvas.
func bombPNG(w, h uint32, depth, colorType byte) []byte {
	ihdr := binary.BigEndian.AppendUint32(nil, w)
	ihdr = binary.BigEndian.AppendUint32(ihdr, h)
	ihdr = append(ihdr, depth, colorType, 0, 0, 0)
	b := []byte("\x89PNG\r\n\x1a\n")
	b = append(b, pngChunk("IHDR", ihdr)...)
	return append(b, pngChunk("IEND", nil)...)
}

func TestDecodedSizeLimit(t *testing.T) {
	p := New(0, 0)
	tests := []struct {
		name string
		data []byte
		want error
	}{
		{"16-bit RGBA 4000x4000 is 128 MB", bombPNG(4000, 4000, 16, 6), domain.ErrTooLarge},
		{"16-bit RGB 4000x4000 is 128 MB", bombPNG(4000, 4000, 16, 2), domain.ErrTooLarge},
		{"8-bit RGBA 4000x4000 is 64 MB and allowed", bombPNG(4000, 4000, 8, 6), nil},
		{"8-bit RGB 4000x4000 allowed", bombPNG(4000, 4000, 8, 2), nil},
		{"16-bit gray 4000x4000 is 32 MB and allowed", bombPNG(4000, 4000, 16, 0), nil},
		{"over the pixel limit", bombPNG(5000, 5000, 8, 0), domain.ErrImageInvalid},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// inspect never decodes, so the missing IDAT data is irrelevant when it accepts.
			_, err := p.inspect(tc.data, p.maxPixels)
			if !errors.Is(err, tc.want) || (tc.want == nil && err != nil) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
	// The public entry points reject the bomb before touching the decoder or the gate.
	bomb := bombPNG(4000, 4000, 16, 6)
	if _, err := p.Process(bomb); !errors.Is(err, domain.ErrTooLarge) {
		t.Fatalf("Process: %v", err)
	}
	if _, err := p.Thumbnail(bomb); !errors.Is(err, domain.ErrTooLarge) {
		t.Fatalf("Thumbnail: %v", err)
	}
}

func TestBytesPerPixel(t *testing.T) {
	tests := []struct {
		m    color.Model
		want int64
	}{
		{color.GrayModel, 1}, {color.Gray16Model, 2}, {color.YCbCrModel, 3}, {color.RGBAModel, 4},
		{color.NRGBAModel, 4}, {color.CMYKModel, 4}, {color.RGBA64Model, 8}, {color.NRGBA64Model, 8},
		{color.Palette{color.Black}, 1}, {color.AlphaModel, 8},
	}
	for _, tc := range tests {
		if got := bytesPerPixel(tc.m); got != tc.want {
			t.Errorf("%T: got %d, want %d", tc.m, got, tc.want)
		}
	}
}

func TestAvatarPixelLimit(t *testing.T) {
	p := New(0, 0)
	// 1800x1800 is 3.2 MP: a valid project image but too big for an avatar source.
	if _, _, err := p.Avatar(context.Background(), makePNG(t, 1800, 1800)); !errors.Is(err, domain.ErrImageInvalid) {
		t.Fatalf("got %v", err)
	}
	if _, err := p.Process(makePNG(t, 1800, 1800)); err != nil {
		t.Fatalf("project image of the same size must pass: %v", err)
	}
}

func TestDecodeGateIsExclusive(t *testing.T) {
	p := New(0, 0)
	p.gate = gate.New(20 * time.Millisecond)
	hold, err := p.gate.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	data := makePNG(t, 20, 20)

	if _, _, err := p.Avatar(context.Background(), data); !errors.Is(err, domain.ErrRateLimited) {
		t.Fatalf("busy gate: got %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := p.Avatar(ctx, data); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: got %v", err)
	}
	if _, err := p.Thumbnail(data); !errors.Is(err, domain.ErrRateLimited) {
		t.Fatalf("thumbnail on busy gate: got %v", err)
	}

	hold()
	if _, _, err := p.Avatar(context.Background(), data); err != nil {
		t.Fatalf("free gate: %v", err)
	}
	// A finished call must have released the slot.
	if _, err := p.Thumbnail(data); err != nil {
		t.Fatalf("slot leaked: %v", err)
	}
}

func jpegSegment(marker byte, payload []byte) []byte {
	b := []byte{0xFF, marker, 0, 0}
	binary.BigEndian.PutUint16(b[2:], uint16(len(payload)+2))
	return append(b, payload...)
}

// insertAfter returns data with extra spliced in at offset at.
func insertAt(data []byte, at int, extra ...[]byte) []byte {
	out := append([]byte(nil), data[:at]...)
	for _, e := range extra {
		out = append(out, e...)
	}
	return append(out, data[at:]...)
}

// noisyJPEG is a JPEG whose entropy-coded data contains stuffed 0xFF00 bytes.
func noisyJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for i := range img.Pix {
		img.Pix[i] = byte(i * 37)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(buf.Bytes(), []byte{0xFF, 0x00}) {
		t.Fatal("test image has no stuffed bytes")
	}
	return buf.Bytes()
}

func TestStripJPEG(t *testing.T) {
	clean := noisyJPEG(t)
	exif := jpegSegment(0xE1, append([]byte("Exif\x00\x00"), []byte("GPSLatitude=41.3")...))
	xmp := jpegSegment(0xE1, []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta/>"))
	iptc := jpegSegment(0xED, []byte("Photoshop 3.0\x008BIM"))
	com := jpegSegment(0xFE, []byte("secret comment"))
	vendor := jpegSegment(0xE3, []byte("meta"))
	mpf := jpegSegment(0xE2, []byte("MPF\x00other-image-offsets"))
	jfif := jpegSegment(0xE0, []byte("JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"))
	icc := jpegSegment(0xE2, []byte("ICC_PROFILE\x00\x01\x01profile-bytes"))
	adobe := jpegSegment(0xEE, []byte("Adobe\x00\x64\x00\x00\x00\x00\x01"))

	tests := []struct {
		name string
		in   []byte
		want []byte
	}{
		{"nothing to strip", clean, clean},
		{"exif and xmp", insertAt(clean, 2, exif, xmp), clean},
		{"iptc and comment and vendor and mpf", insertAt(clean, 2, iptc, com, vendor, mpf), clean},
		{"metadata between other segments", insertAt(clean, 2, jfif, exif, icc), insertAt(clean, 2, jfif, icc)},
		{"adobe transform is kept", insertAt(clean, 2, adobe, com), insertAt(clean, 2, adobe)},
		{"trailing data after EOI", append(append([]byte(nil), clean...), []byte("GPS-in-a-trailer")...), clean},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := stripJPEG(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, tc.want) {
				t.Fatalf("output differs (%d bytes, want %d)", len(got), len(tc.want))
			}
			if bytes.Contains(got, []byte("GPS")) || bytes.Contains(got, []byte("Exif")) {
				t.Fatal("metadata survived")
			}
			if _, err := jpeg.Decode(bytes.NewReader(got)); err != nil {
				t.Fatalf("stripped image does not decode: %v", err)
			}
		})
	}
	for name, in := range map[string][]byte{
		"not a jpeg":    []byte("hello"),
		"no EOI":        clean[:len(clean)-2],
		"truncated seg": clean[:10],
	} {
		if _, err := stripJPEG(in); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestStripPNG(t *testing.T) {
	clean := makePNG(t, 30, 20)
	const ihdrEnd = 8 + 25 // signature, then length+type+13 bytes+CRC
	ihdr, tail := clean[8:ihdrEnd], clean[ihdrEnd:]

	text := pngChunk("tEXt", []byte("Location\x0041.3,69.2"))
	ztxt := pngChunk("zTXt", []byte("Comment\x00\x00xx"))
	itxt := pngChunk("iTXt", []byte("XML:com.adobe.xmp\x00\x00\x00\x00\x00<x/>"))
	exif := pngChunk("eXIf", []byte("MM\x00*GPS"))
	tm := pngChunk("tIME", []byte{7, 234, 1, 2, 3, 4, 5})
	gama := pngChunk("gAMA", []byte{0, 0, 0xB1, 0x8F})
	phys := pngChunk("pHYs", []byte{0, 0, 0x0B, 0x13, 0, 0, 0x0B, 0x13, 1})
	srgb := pngChunk("sRGB", []byte{0})
	icc := pngChunk("iCCP", []byte("p\x00\x00data"))

	build := func(extra ...[]byte) []byte {
		out := append([]byte(nil), clean[:8]...)
		out = append(out, ihdr...)
		for _, e := range extra {
			out = append(out, e...)
		}
		return append(out, tail...)
	}
	tests := []struct {
		name     string
		in, want []byte
	}{
		{"nothing to strip", clean, clean},
		{"text chunks", build(text, ztxt, itxt), clean},
		{"exif and time", build(exif, tm), clean},
		{"colour chunks are kept", build(gama, srgb, icc, phys, text), build(gama, srgb, icc, phys)},
		{"data after IEND", append(append([]byte(nil), clean...), []byte("trailing GPS data")...), clean},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := stripPNG(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, tc.want) {
				t.Fatalf("output differs (%d bytes, want %d)", len(got), len(tc.want))
			}
			if _, err := png.Decode(bytes.NewReader(got)); err != nil {
				t.Fatalf("stripped image does not decode: %v", err)
			}
		})
	}
	for name, in := range map[string][]byte{
		"short":         []byte("\x89PNG"),
		"no IEND":       clean[:len(clean)-12],
		"chunk too big": append(append([]byte(nil), clean[:8]...), 0xFF, 0xFF, 0xFF, 0xFF, 'I', 'H', 'D', 'R', 0, 0, 0, 0),
	} {
		if _, err := stripPNG(in); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestProcessStripsMetadata(t *testing.T) {
	p := New(0, 0)
	jpg := noisyJPEG(t)
	withExif := insertAt(jpg, 2, jpegSegment(0xE1, []byte("Exif\x00\x00GPS")))
	pngData := makePNG(t, 30, 20)
	withText := insertAt(pngData, 33, pngChunk("tEXt", []byte("GPS\x001")))

	for name, tc := range map[string]struct{ in, want []byte }{"jpeg": {withExif, jpg}, "png": {withText, pngData}} {
		t.Run(name, func(t *testing.T) {
			got, err := p.Process(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.Data, tc.want) || got.SHA256 != sum(tc.want) {
				t.Fatal("stored bytes are not the stripped original")
			}
		})
	}
}
