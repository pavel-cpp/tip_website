package sheets

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

// Export formats.
const (
	FormatXLSX = "xlsx"
	FormatCSV  = "csv"
)

// Limits protecting the 2 GB server from hostile or accidental huge files.
const (
	// maxXLSXBytes bounds the compressed workbook held in memory by the XLSX reader.
	maxXLSXBytes = 32 << 20
	// maxUnzipBytes and maxUnzipXMLBytes bound the decompressed size (zip bombs).
	maxUnzipBytes    = 128 << 20
	maxUnzipXMLBytes = 48 << 20
	// maxCSVRecordBytes bounds a single CSV record so a file without line breaks cannot exhaust memory.
	maxCSVRecordBytes = 256 << 10
)

var (
	xlsxMagic = []byte("PK\x03\x04")
	oleMagic  = []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1} // legacy .xls
)

// Codec reads and writes participant tables. The zero value is ready to use.
type Codec struct{}

// Header cells written by Write; they are among the names Read recognizes.
var exportHeader = []string{"number", "name", "phone"}

// Read parses an XLSX or CSV table from r (the format is detected from the content, not from
// a file name) and calls emit for every non-empty data row with its 1-based line number in
// the file. A header row is detected and skipped; headerless files use positional columns.
// More than maxRows data rows yield domain.ErrTooLarge; content that is neither XLSX nor
// text yields domain.ErrUnsupportedMedia; unreadable files yield a validation error on
// "file". An error returned by emit stops the read and is returned unchanged.
func (Codec) Read(r io.Reader, maxRows int, emit func(line int, name, phone string) error) error {
	br := bufio.NewReaderSize(r, 16)
	head, err := br.Peek(len(oleMagic))
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read sheet header: %w", err)
	}
	switch {
	case bytes.HasPrefix(head, xlsxMagic):
		return readXLSX(br, maxRows, emit)
	case bytes.HasPrefix(head, oleMagic):
		return domain.ErrUnsupportedMedia
	default:
		return readCSV(br, maxRows, emit)
	}
}

// rowReader turns a stream of raw string rows into emit calls, owning header detection, the
// row limit and empty-row skipping so that XLSX and CSV share one implementation.
type rowReader struct {
	maxRows int
	emit    func(line int, name, phone string) error

	started bool
	cols    columnMap
	rows    int
}

func (rr *rowReader) add(line int, row []string) error {
	if rowEmpty(row) {
		return nil
	}
	if !rr.started {
		rr.started = true
		if m, ok := detectHeader(row); ok {
			rr.cols = m
			return nil
		}
		rr.cols = positionalColumns(len(row))
	}
	name, phone := cell(row, rr.cols.name), cell(row, rr.cols.phone)
	if name == "" && phone == "" {
		return nil // a lone number carries no participant data
	}
	rr.rows++
	if rr.rows > rr.maxRows {
		return domain.ErrTooLarge
	}
	return rr.emit(line, name, phone)
}

func fileProblem(reason string) error {
	return domain.NewValidation(domain.FieldError{Field: "file", Reason: reason})
}

func readCSV(r io.Reader, maxRows int, emit func(int, string, string) error) error {
	text, err := decodeText(r)
	if err != nil {
		return fmt.Errorf("decode csv: %w", err)
	}
	br := bufio.NewReaderSize(text, sampleSize)
	sample, err := br.Peek(sampleSize)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, bufio.ErrBufferFull) {
		return fmt.Errorf("read csv sample: %w", err)
	}

	cr := csv.NewReader(&recordLimiter{r: br})
	cr.Comma = DetectDelimiter(string(sample))
	cr.LazyQuotes = true
	cr.FieldsPerRecord = -1
	cr.TrimLeadingSpace = true
	cr.ReuseRecord = true

	rr := &rowReader{maxRows: maxRows, emit: emit}
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			if errors.Is(err, errRecordTooLong) {
				return fileProblem("a row is too long")
			}
			return fileProblem("the CSV cannot be parsed")
		}
		line, _ := cr.FieldPos(0)
		if err := rr.add(line, rec); err != nil {
			return err
		}
	}
}

var errRecordTooLong = errors.New("csv record too long")

// recordLimiter fails when more than maxCSVRecordBytes pass without a newline, which would
// otherwise let a single huge "line" be buffered by encoding/csv.
type recordLimiter struct {
	r       io.Reader
	sinceNL int
}

func (l *recordLimiter) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	for _, b := range p[:n] {
		if b == '\n' {
			l.sinceNL = 0
			continue
		}
		l.sinceNL++
		if l.sinceNL > maxCSVRecordBytes {
			return n, errRecordTooLong
		}
	}
	return n, err
}

func readXLSX(r io.Reader, maxRows int, emit func(int, string, string) error) error {
	data, err := io.ReadAll(io.LimitReader(r, maxXLSXBytes+1))
	if err != nil {
		return fmt.Errorf("read xlsx: %w", err)
	}
	if len(data) > maxXLSXBytes {
		return domain.ErrTooLarge
	}
	f, err := excelize.OpenReader(bytes.NewReader(data), excelize.Options{
		UnzipSizeLimit:    maxUnzipBytes,
		UnzipXMLSizeLimit: maxUnzipXMLBytes,
	})
	if err != nil {
		return fileProblem("the workbook cannot be read")
	}
	defer func() { _ = f.Close() }()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return fileProblem("the workbook has no sheets")
	}
	rows, err := f.Rows(sheets[0])
	if err != nil {
		return fileProblem("the first sheet cannot be read")
	}
	defer func() { _ = rows.Close() }()

	rr := &rowReader{maxRows: maxRows, emit: emit}
	line := 0
	for rows.Next() {
		line++
		// Raw values keep long phone numbers stored as numbers from turning into 9.98E+11.
		cols, err := rows.Columns(excelize.Options{RawCellValue: true})
		if err != nil {
			return fileProblem("a row cannot be read")
		}
		if err := rr.add(line, cols); err != nil {
			return err
		}
	}
	if err := rows.Error(); err != nil {
		return fileProblem("the first sheet cannot be read")
	}
	return nil
}

// Write encodes rows as the given format (FormatXLSX or FormatCSV) with the columns number,
// name, phone. CSV is UTF-8 with a byte order mark and ';' as delimiter so Excel opens it
// correctly in ru and uz locales; Read detects both. Cells that a spreadsheet could execute
// as a formula are neutralized.
func (Codec) Write(w io.Writer, format string, rows []domain.Participant) error {
	switch format {
	case FormatXLSX:
		return writeXLSX(w, rows)
	case FormatCSV:
		return writeCSV(w, rows)
	default:
		return fmt.Errorf("unsupported sheet format %q", format)
	}
}

func writeCSV(w io.Writer, rows []domain.Participant) error {
	if _, err := w.Write(bomUTF8); err != nil {
		return err
	}
	cw := csv.NewWriter(w)
	cw.Comma = ';'
	cw.UseCRLF = true
	if err := cw.Write(exportHeader); err != nil {
		return err
	}
	rec := make([]string, 3)
	for _, p := range rows {
		rec[0] = strconv.Itoa(p.Number)
		rec[1] = csvSafe(p.Name)
		rec[2] = csvSafe(p.Phone)
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

func writeXLSX(w io.Writer, rows []domain.Participant) error {
	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	const sheet = "Sheet1"

	sw, err := f.NewStreamWriter(sheet)
	if err != nil {
		return err
	}
	if err := sw.SetColWidth(1, 1, 10); err != nil {
		return err
	}
	if err := sw.SetColWidth(2, 2, 40); err != nil {
		return err
	}
	if err := sw.SetColWidth(3, 3, 22); err != nil {
		return err
	}
	if err := sw.SetRow("A1", []any{exportHeader[0], exportHeader[1], exportHeader[2]}); err != nil {
		return err
	}
	for i, p := range rows {
		cellRef, err := excelize.CoordinatesToCellName(1, i+2)
		if err != nil {
			return err
		}
		// Strings are stored as text cells, never as formulas, so no escaping is needed here.
		if err := sw.SetRow(cellRef, []any{p.Number, p.Name, p.Phone}); err != nil {
			return err
		}
	}
	if err := sw.Flush(); err != nil {
		return err
	}
	return f.Write(w)
}

// csvSafe neutralizes spreadsheet formula injection by prefixing an apostrophe to cells that
// start with '=' or '@', or with '+' or '-' unless the cell looks like a phone number (digits,
// spaces and punctuation only), which legitimately starts with '+'.
func csvSafe(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '@', '\t', '\r':
		return "'" + s
	case '+', '-':
		if !phoneLike(s) {
			return "'" + s
		}
	}
	return s
}

func phoneLike(s string) bool {
	digits := 0
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			digits++
		case strings.ContainsRune("+-() .", r):
		default:
			return false
		}
	}
	return digits > 0
}
