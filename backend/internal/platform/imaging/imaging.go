// Package imaging validates, decodes, downscales and re-encodes uploaded images using pure Go
// (no cgo). It defends against decompression bombs by estimating the decoded size from the
// header before the pixels are decoded, and it runs at most one decode at a time per process.
package imaging

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"

	"golang.org/x/image/draw"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/gate"
)

// Output limits and quality.
const (
	// AvatarSize is the side of the square avatar.
	AvatarSize = 256
	// MaxAvatarBytes is the largest accepted avatar JPEG (matches the schema CHECK).
	MaxAvatarBytes = 256 << 10
	// MaxAvatarPixels bounds the source of an avatar. Avatars are shown at 28-256 px, so the
	// cap has headroom for a Full HD screenshot (2.07 MP) without letting any signed-in user
	// make the server decode a 16 MP image.
	MaxAvatarPixels = 2_500_000
	// MaxDecodedBytes bounds the estimated in-memory size of a decoded image. It admits a
	// 16 MP 8-bit RGBA bitmap (64 MB, the decoder's output for an 8-bit RGB PNG) but rejects
	// 16-bit images such as a 4000x4000 RGBA64 PNG (128 MB) that fit in the pixel limit and a
	// 100 KB upload.
	MaxDecodedBytes = 64 << 20

	jpegQuality  = 90
	thumbQuality = 80
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
	maxBytes   int
	maxPixels  int
	maxSide    int
	maxDecoded int64
	gate       *gate.Gate
}

// New returns a Processor. Non-positive limits fall back to the domain defaults.
func New(maxBytes, maxPixels int) *Processor {
	if maxBytes <= 0 {
		maxBytes = domain.MaxImageBytes
	}
	if maxPixels <= 0 {
		maxPixels = domain.MaxImagePixels
	}
	return &Processor{
		maxBytes: maxBytes, maxPixels: maxPixels, maxSide: domain.MaxImageSide,
		maxDecoded: MaxDecodedBytes, gate: gate.Heavy,
	}
}

// bytesPerPixel is the size of one pixel in the image type the standard decoders produce for
// a colour model. Unknown models are assumed to be the largest (64-bit) layout.
func bytesPerPixel(m color.Model) int64 {
	if _, ok := m.(color.Palette); ok {
		return 1
	}
	switch m {
	case color.GrayModel:
		return 1
	case color.Gray16Model:
		return 2
	case color.YCbCrModel:
		return 3 // 4:4:4 upper bound; subsampled JPEGs use less
	case color.RGBAModel, color.NRGBAModel, color.CMYKModel:
		return 4
	}
	return 8
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

// inspect validates the magic bytes and the header-declared size without decoding any pixel,
// so a bomb is rejected before memory is allocated. Errors are domain errors:
// ErrUnsupportedMedia, ErrTooLarge, ErrImageInvalid.
func (p *Processor) inspect(data []byte, maxPixels int) (string, error) {
	if len(data) > p.maxBytes {
		return "", domain.ErrTooLarge
	}
	mime, ok := detect(data)
	if !ok {
		return "", domain.ErrUnsupportedMedia
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", domain.ErrImageInvalid
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return "", domain.ErrImageInvalid
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	if pixels > int64(maxPixels) {
		return "", domain.ErrImageInvalid
	}
	// The pixel count alone does not bound memory: 16-bit channels double the decoded size.
	if pixels*bytesPerPixel(cfg.ColorModel) > p.maxDecoded {
		return "", domain.ErrTooLarge
	}
	return mime, nil
}

// decode fully decodes data that inspect accepted. The caller holds the gate.
func decode(data []byte, mime string) (image.Image, error) {
	var (
		img image.Image
		err error
	)
	if mime == MimePNG {
		img, err = png.Decode(bytes.NewReader(data))
	} else {
		img, err = jpeg.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, domain.ErrImageInvalid
	}
	return img, nil
}

// open validates data, waits for the process-wide decode slot and decodes the image. The
// returned release must be called once the caller is done with the pixels (after scaling), so
// two uploads never hold decoded bitmaps at the same time.
func (p *Processor) open(ctx context.Context, data []byte, maxPixels int) (img image.Image, mime string, release func(), err error) {
	mime, err = p.inspect(data, maxPixels)
	if err != nil {
		return nil, "", nil, err
	}
	release, err = p.gate.Acquire(ctx)
	if err != nil {
		return nil, "", nil, err
	}
	img, err = decode(data, mime)
	if err != nil {
		release()
		return nil, "", nil, err
	}
	return img, mime, release, nil
}

// Process validates an uploaded PNG or JPEG, downscales it to at most 4096 px on the long side
// and returns the bytes to store. An image that already fits keeps its pixel data byte for
// byte; only metadata (EXIF/GPS, text chunks, trailing data) is stripped, so the content hash
// is that of the stripped file. A downscaled image is re-encoded in its original format.
func (p *Processor) Process(data []byte) (Processed, error) {
	img, mime, release, err := p.open(context.Background(), data, p.maxPixels)
	if err != nil {
		return Processed{}, err
	}
	defer release()
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	var out []byte
	if max(w, h) > p.maxSide {
		nw, nh := fitSide(w, h, p.maxSide)
		dst := image.NewNRGBA(image.Rect(0, 0, nw, nh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
		out, err = encode(dst, mime)
		if err != nil {
			return Processed{}, err
		}
		w, h = nw, nh
	} else if out, err = stripMetadata(data, mime); err != nil {
		return Processed{}, domain.ErrImageInvalid
	}
	return Processed{Data: out, SHA256: sum(out), Mime: mime, Width: w, Height: h}, nil
}

// Normalize is Process flattened to plain values; it satisfies the projects service port
// without the service having to import this package.
func (p *Processor) Normalize(data []byte) (out []byte, mime string, width, height int, err error) {
	r, err := p.Process(data)
	if err != nil {
		return nil, "", 0, 0, err
	}
	return r.Data, r.Mime, r.Width, r.Height, nil
}

// Thumbnail decodes an image and returns a JPEG preview whose long side is at most
// domain.ThumbSide pixels; smaller images keep their size. Transparent areas are flattened
// onto white because JPEG has no alpha channel.
func (p *Processor) Thumbnail(data []byte) ([]byte, error) {
	img, _, release, err := p.open(context.Background(), data, p.maxPixels)
	if err != nil {
		return nil, err
	}
	defer release()
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if max(w, h) > domain.ThumbSide {
		w, h = fitSide(w, h, domain.ThumbSide)
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: thumbQuality}); err != nil {
		return nil, domain.ErrImageInvalid
	}
	return buf.Bytes(), nil
}

// Avatar center-crops the image to a square, resizes it to 256x256 and encodes it as JPEG of at
// most 256 KB. Waiting for the decode slot ends with ctx.
func (p *Processor) Avatar(ctx context.Context, data []byte) (jpegBytes []byte, sha string, err error) {
	img, _, release, err := p.open(ctx, data, min(p.maxPixels, MaxAvatarPixels))
	if err != nil {
		return nil, "", err
	}
	defer release()
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
