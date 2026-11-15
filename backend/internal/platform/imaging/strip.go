package imaging

import (
	"bytes"
	"encoding/binary"
	"errors"
)

var errMalformed = errors.New("malformed image container")

// stripMetadata removes privacy-sensitive metadata without touching pixel data, so a stored
// image keeps its exact quality: JPEG loses EXIF/XMP (APP1), IPTC (APP13), other vendor APPn
// segments, comments and any bytes after the end-of-image marker; PNG loses text, time and
// EXIF chunks and anything after IEND. Colour information (ICC, gamma, sRGB, pHYs, ...) stays.
func stripMetadata(data []byte, mime string) ([]byte, error) {
	if mime == MimePNG {
		return stripPNG(data)
	}
	return stripJPEG(data)
}

// jpegKeepsSegment reports whether an APPn or COM segment is needed to display the image:
// JFIF (APP0), the ICC profile (APP2 with its signature) and Adobe's colour transform (APP14).
func jpegKeepsSegment(marker byte, payload []byte) bool {
	switch {
	case marker == 0xE0 || marker == 0xEE:
		return true
	case marker == 0xE2:
		return bytes.HasPrefix(payload, []byte("ICC_PROFILE\x00"))
	case marker == 0xFE || (marker > 0xE0 && marker <= 0xEF):
		return false
	}
	return true
}

func stripJPEG(data []byte) ([]byte, error) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil, errMalformed
	}
	out := make([]byte, 0, len(data))
	out = append(out, 0xFF, 0xD8)
	i := 2
	for {
		if i+1 >= len(data) || data[i] != 0xFF {
			return nil, errMalformed
		}
		for i+2 < len(data) && data[i+1] == 0xFF { // fill bytes before a marker
			i++
		}
		m := data[i+1]
		switch {
		case m == 0xD9:
			return append(out, 0xFF, 0xD9), nil
		case m == 0x01 || (m >= 0xD0 && m <= 0xD8): // markers without a length field
			out = append(out, 0xFF, m)
			i += 2
			continue
		}
		if i+4 > len(data) {
			return nil, errMalformed
		}
		n := int(binary.BigEndian.Uint16(data[i+2:]))
		if n < 2 || i+2+n > len(data) {
			return nil, errMalformed
		}
		if jpegKeepsSegment(m, data[i+4:i+2+n]) {
			out = append(out, data[i:i+2+n]...)
		}
		i += 2 + n
		if m != 0xDA {
			continue
		}
		// Entropy-coded scan data runs until a real marker: 0xFF 0x00 is a stuffed byte and
		// RSTn markers belong to the scan.
		j := i
		for j+1 < len(data) {
			if data[j] == 0xFF && data[j+1] != 0x00 && data[j+1] != 0xFF && (data[j+1] < 0xD0 || data[j+1] > 0xD7) {
				break
			}
			j++
		}
		if j+1 >= len(data) {
			return nil, errMalformed
		}
		out = append(out, data[i:j]...)
		i = j
	}
}

// pngDropped lists the ancillary chunks that carry free text, timestamps or camera data.
var pngDropped = map[string]bool{"tEXt": true, "zTXt": true, "iTXt": true, "eXIf": true, "tIME": true}

func stripPNG(data []byte) ([]byte, error) {
	const sigLen = 8
	if len(data) < sigLen {
		return nil, errMalformed
	}
	out := make([]byte, 0, len(data))
	out = append(out, data[:sigLen]...)
	i := sigLen
	for {
		if i+12 > len(data) { // length, type and CRC
			return nil, errMalformed
		}
		n := int64(binary.BigEndian.Uint32(data[i:]))
		end := int64(i) + 12 + n
		if end > int64(len(data)) {
			return nil, errMalformed
		}
		typ := string(data[i+4 : i+8])
		if !pngDropped[typ] {
			out = append(out, data[i:end]...)
		}
		i = int(end)
		if typ == "IEND" {
			return out, nil
		}
	}
}
