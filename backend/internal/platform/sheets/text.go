package sheets

import (
	"bufio"
	"bytes"
	"io"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// sampleSize is how much of a CSV is inspected to pick the encoding and the delimiter.
const sampleSize = 64 << 10

var (
	bomUTF8    = []byte{0xEF, 0xBB, 0xBF}
	bomUTF16LE = []byte{0xFF, 0xFE}
	bomUTF16BE = []byte{0xFE, 0xFF}
)

// decodeText wraps r so that it yields UTF-8 without a byte order mark. UTF-8 (with or without
// BOM) is passed through, UTF-16 with BOM is converted, and any other byte stream is read as
// Windows-1251, the encoding Russian Excel uses for "CSV". Only the first sampleSize bytes are
// inspected, so memory stays bounded for large files.
func decodeText(r io.Reader) (io.Reader, error) {
	br := bufio.NewReaderSize(r, sampleSize)
	head, err := br.Peek(sampleSize)
	if err != nil && err != io.EOF && err != bufio.ErrBufferFull {
		return nil, err
	}
	switch {
	case bytes.HasPrefix(head, bomUTF8):
		_, _ = br.Discard(len(bomUTF8))
		return br, nil
	case bytes.HasPrefix(head, bomUTF16LE):
		return transform.NewReader(br, unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder()), nil
	case bytes.HasPrefix(head, bomUTF16BE):
		return transform.NewReader(br, unicode.UTF16(unicode.BigEndian, unicode.UseBOM).NewDecoder()), nil
	case validUTF8Sample(head):
		return br, nil
	default:
		return transform.NewReader(br, charmap.Windows1251.NewDecoder()), nil
	}
}

// validUTF8Sample reports whether b is valid UTF-8, tolerating a multi-byte rune cut off at
// the end because the sample is a prefix of a longer stream.
func validUTF8Sample(b []byte) bool {
	if utf8.Valid(b) {
		return true
	}
	for cut := 1; cut < utf8.UTFMax && cut <= len(b); cut++ {
		if utf8.Valid(b[:len(b)-cut]) {
			return true
		}
	}
	return false
}

// delimiters are the supported CSV separators in tie-break order.
var delimiters = []rune{';', ',', '\t', '|'}

// DetectDelimiter guesses the CSV delimiter from the first lines of text. Delimiters inside
// double quotes are ignored. The delimiter that appears with the same positive count on the
// most lines wins; ties go to ';' then ',' (Excel in ru/uz locales writes ';'). Without any
// candidate it returns ','.
func DetectDelimiter(sample string) rune {
	const maxLines = 20
	counts := make(map[rune][]int, len(delimiters))
	line := make(map[rune]int, len(delimiters))
	inQuotes := false
	lines := 0
	flush := func() {
		empty := true
		for _, d := range delimiters {
			if line[d] > 0 {
				empty = false
			}
		}
		if !empty {
			for _, d := range delimiters {
				counts[d] = append(counts[d], line[d])
			}
		}
		for _, d := range delimiters {
			line[d] = 0
		}
		lines++
	}
	for _, r := range sample {
		if lines >= maxLines {
			break
		}
		switch {
		case r == '"':
			inQuotes = !inQuotes
		case r == '\n' && !inQuotes:
			flush()
		case !inQuotes:
			for _, d := range delimiters {
				if r == d {
					line[d]++
				}
			}
		}
	}
	if lines < maxLines {
		flush() // the sample may not end with a newline
	}

	best, bestScore := ',', 0
	for _, d := range delimiters {
		if score := consistency(counts[d]); score > bestScore {
			best, bestScore = d, score
		}
	}
	return best
}

// consistency scores a delimiter by how many sampled lines contain its most common positive
// count; a delimiter that never splits a line scores 0.
func consistency(perLine []int) int {
	freq := map[int]int{}
	best := 0
	for _, n := range perLine {
		if n == 0 {
			continue
		}
		freq[n]++
		if freq[n] > best {
			best = freq[n]
		}
	}
	return best
}
