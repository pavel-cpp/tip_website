// Package imaging validates, decodes, downscales and re-encodes uploaded images using pure Go
// (no cgo). It defends against decompression bombs by checking the declared dimensions before
// the pixels are decoded.
package imaging

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/jpeg"
	"image/png"

	"golang.org/x/image/draw"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Output limits and quality.
const (
	// AvatarSize is the side of the square avatar.
	AvatarSize = 256
	// MaxAvatarBytes is the largest accepted avatar JPEG (matches the schema CHECK).
	MaxAvatarBytes = 256 << 10

	jpegQuality = 90
)

// Mime types produced and accepted.
const (
	MimePNG  = "image/png"
	MimeJPEG = "image/jpeg"
)

// Processed is a validated image ready to be stored.
type Processed struct {
	Data   []byte
	SHA256 string
	Mime   string
	Width  int
	Height int
}

// Processor holds the upload limits. Use New to build one.
type Processor struct {
	maxBytes  int
	maxPixels int
	maxSide   int
}

// New returns a Processor. Non-positive limits fall back to the domain defaults.
func New(maxBytes, maxPixels int) *Processor {
	if maxBytes <= 0 {
		maxBytes = domain.MaxImageBytes
	}
	if maxPixels <= 0 {
		maxPixels = domain.MaxImagePixels
	}
	return &Processor{maxBytes: maxBytes, maxPixels: maxPixels, maxSide: domain.MaxImageSide}
}

// detect returns the mime type from the magic bytes only.
func detect(data []byte) (string, bool) {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return MimePNG, true
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return MimeJPEG, true
	}
	return "", false
}

// decode validates the magic bytes, the declared size and then fully decodes the image.
// Errors are domain errors: ErrUnsupportedMedia, ErrTooLarge, ErrImageInvalid.
func (p *Processor) decode(data []byte) (image.Image, string, error) {
	if len(data) > p.maxBytes {
		return nil, "", domain.ErrTooLarge
	}
	mime, ok := detect(data)
	if !ok {
		return nil, "", domain.ErrUnsupportedMedia
	}
	// DecodeConfig reads only the header, so a bomb is rejected before any pixel is allocated.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", domain.ErrImageInvalid
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > int64(p.maxPixels) {
		return nil, "", domain.ErrImageInvalid
	}
	var img image.Image
	if mime == MimePNG {
		img, err = png.Decode(bytes.NewReader(data))
	} else {
		img, err = jpeg.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, "", domain.ErrImageInvalid
	}
	return img, mime, nil
}

// Process validates an uploaded PNG or JPEG, downscales it to at most 4096 px on the long side
// and returns the bytes to store. An image that already fits is returned unchanged (the
// original bytes are kept, so the content hash equals the uploaded file). A downscaled image
// is re-encoded in its original format.
func (p *Processor) Process(data []byte) (Processed, error) {
	img, mime, err := p.decode(data)
	if err != nil {
		return Processed{}, err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	out := data
	if max(w, h) > p.maxSide {
		nw, nh := fitSide(w, h, p.maxSide)
		dst := image.NewNRGBA(image.Rect(0, 0, nw, nh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
		out, err = encode(dst, mime)
		if err != nil {
			return Processed{}, err
		}
		w, h = nw, nh
	}
	return Processed{Data: out, SHA256: sum(out), Mime: mime, Width: w, Height: h}, nil
}

// Avatar center-crops the image to a square, resizes it to 256x256 and encodes it as JPEG of at
// most 256 KB.
func (p *Processor) Avatar(data []byte) (jpegBytes []byte, sha string, err error) {
	img, _, err := p.decode(data)
	if err != nil {
		return nil, "", err
	}
	b := img.Bounds()
	side := min(b.Dx(), b.Dy())
	x0 := b.Min.X + (b.Dx()-side)/2
	y0 := b.Min.Y + (b.Dy()-side)/2
	src := image.Rect(x0, y0, x0+side, y0+side)
	dst := image.NewRGBA(image.Rect(0, 0, AvatarSize, AvatarSize))
	// Fill white first so transparent PNG regions do not turn black in the JPEG.
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, src, draw.Over, nil)
	for q := jpegQuality; ; q -= 15 {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: q}); err != nil {
			return nil, "", domain.ErrImageInvalid
		}
		if buf.Len() <= MaxAvatarBytes {
			return buf.Bytes(), sum(buf.Bytes()), nil
		}
		if q <= 30 {
			return nil, "", domain.ErrImageInvalid
		}
	}
}

// fitSide scales (w, h) so that the long side equals limit, keeping the aspect ratio.
func fitSide(w, h, limit int) (int, int) {
	if w >= h {
		return limit, max(1, (h*limit+w/2)/w)
	}
	return max(1, (w*limit+h/2)/h), limit
}

func encode(img image.Image, mime string) ([]byte, error) {
	var buf bytes.Buffer
	var err error
	if mime == MimePNG {
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, img)
	} else {
		err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQuality})
	}
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
