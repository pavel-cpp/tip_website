package sheets

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
)

type row struct {
	line        int
	name, phone string
}

func readAll(t *testing.T, data []byte, maxRows int) ([]row, error) {
	t.Helper()
	var out []row
	err := Codec{}.Read(bytes.NewReader(data), maxRows, func(line int, name, phone string) error {
		out = append(out, row{line, name, phone})
		return nil
	})
	return out, err
}

func TestNormalizeHeader(t *testing.T) {
	cases := map[string]string{
		"  Ф.И.О. ":      "ф и о",
		"Ёлка":           "елка",
		"Phone Number":   "phone number",
		"№":              "№",
		"п/п":            "п п",
		"O'zbek":         "ozbek",
		"Telefon raqami": "telefon raqami",
	}
	for in, want := range cases {
		if got := normalizeHeader(in); got != want {
			t.Errorf("normalizeHeader(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDetectHeader(t *testing.T) {
	cases := []struct {
		name string
		row  []string
		want columnMap
		ok   bool
	}{
		{"english", []string{"Number", "Name", "Phone"}, columnMap{0, 1, 2}, true},
		{"russian", []string{"№", "ФИО", "Телефон"}, columnMap{0, 1, 2}, true},
		{"russian phone number", []string{"Номер", "Имя", "Номер телефона"}, columnMap{0, 1, 2}, true},
		{"uzbek cyrillic", []string{"Исм", "Телефон рақами"}, columnMap{-1, 0, 1}, true},
		{"uzbek latin", []string{"Ism", "Telefon raqami"}, columnMap{-1, 0, 1}, true},
		{"reordered", []string{"phone", "name"}, columnMap{-1, 1, 0}, true},
		{"only number is not a header", []string{"number", "1"}, columnMap{-1, -1, -1}, false},
		{"data row", []string{"Azam Tursunov", "+998 90 123-45-67"}, columnMap{-1, -1, -1}, false},
	}
	for _, c := range cases {
		got, ok := detectHeader(c.row)
		if ok != c.ok {
			t.Errorf("%s: ok = %v", c.name, ok)
			continue
		}
		if ok && got != c.want {
			t.Errorf("%s: map = %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestPositionalColumns(t *testing.T) {
	if got := positionalColumns(3); got != (columnMap{0, 1, 2}) {
		t.Errorf("3 columns: %+v", got)
	}
	if got := positionalColumns(2); got != (columnMap{-1, 0, 1}) {
		t.Errorf("2 columns: %+v", got)
	}
	if got := positionalColumns(1); got != (columnMap{-1, 0, -1}) {
		t.Errorf("1 column: %+v", got)
	}
}

func TestDetectDelimiter(t *testing.T) {
	cases := []struct {
		name, in string
		want     rune
	}{
		{"semicolon", "a;b;c\n1;2;3\n", ';'},
		{"comma", "a,b,c\n1,2,3\n", ','},
		{"tab", "a\tb\tc\n1\t2\t3\n", '\t'},
		{"pipe", "a|b\n1|2\n", '|'},
		{"decimal commas under semicolons", "a;b\n1,5;2,5\n", ';'},
		{"quoted delimiter ignored", "\"a;b\",c\n\"1;2\",3\n", ','},
		{"single column defaults to comma", "name\nfoo\n", ','},
		{"no trailing newline", "a;b", ';'},
	}
	for _, c := range cases {
		if got := DetectDelimiter(c.in); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestCleanCell(t *testing.T) {
	cases := map[string]string{
		"  Azam  ":                            "Azam",
		"a\x00b":                              "ab",
		"line1\nline2":                        "line1 line2",
		"tab\there":                           "tab here",
		"bad" + string([]byte{0xff}) + "byte": "bad" + string(rune(0xFFFD)) + "byte",
		string(rune(0xFEFF)) + "bom":          "bom",
		"nbsp" + string(rune(0xA0)) + "separated": "nbsp separated",
	}
	for in, want := range cases {
		if got := cleanCell(in); got != want {
			t.Errorf("cleanCell(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadCSVWithHeader(t *testing.T) {
	data := []byte("\xEF\xBB\xBF№;ФИО;Телефон\r\n1;Азам Турсунов;+998901234567\r\n\r\n2;  Шарафутдин  ;\r\n")
	got, err := readAll(t, data, 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []row{{2, "Азам Турсунов", "+998901234567"}, {4, "Шарафутдин", ""}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestReadCSVHeaderless(t *testing.T) {
	got, err := readAll(t, []byte("Ivan,+7 926 071-91-98\nPetr,\n"), 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []row{{1, "Ivan", "+7 926 071-91-98"}, {2, "Petr", ""}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestReadCSVThreeColumnsHeaderless(t *testing.T) {
	got, err := readAll(t, []byte("7,Ivan,123\n"), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].name != "Ivan" || got[0].phone != "123" {
		t.Fatalf("got %v", got)
	}
}

func TestReadCSVQuotedAndLazyQuotes(t *testing.T) {
	got, err := readAll(t, []byte("name,phone\n\"Doe, John\",\"1\n2\"\nBad \"quote,5\n"), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].name != "Doe, John" || got[0].phone != "1 2" || got[1].name != `Bad "quote` {
		t.Fatalf("got %v", got)
	}
}

func TestReadCSVEncodings(t *testing.T) {
	const text = "имя;телефон\nАзам;+998901234567\n"
	cp1251, err := charmap.Windows1251.NewEncoder().String(text)
	if err != nil {
		t.Fatal(err)
	}
	utf16, err := unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewEncoder().String(strings.ReplaceAll(text, ";", "\t"))
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		"utf8":    []byte(text),
		"utf8bom": append([]byte{0xEF, 0xBB, 0xBF}, text...),
		"cp1251":  []byte(cp1251),
		"utf16le": []byte(utf16),
	} {
		got, err := readAll(t, data, 10)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if len(got) != 1 || got[0].name != "Азам" || got[0].phone != "+998901234567" {
			t.Errorf("%s: got %v", name, got)
		}
	}
}

func TestReadEmptyInput(t *testing.T) {
	got, err := readAll(t, nil, 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestReadRowLimit(t *testing.T) {
	data := []byte("name\na\nb\nc\n")
	if _, err := readAll(t, data, 3); err != nil {
		t.Fatalf("at the limit: %v", err)
	}
	if _, err := readAll(t, data, 2); !errors.Is(err, domain.ErrTooLarge) {
		t.Fatalf("over the limit: got %v, want ErrTooLarge", err)
	}
}

func TestReadEmitErrorStops(t *testing.T) {
	stop := errors.New("stop")
	n := 0
	err := Codec{}.Read(strings.NewReader("name\na\nb\n"), 10, func(int, string, string) error {
		n++
		return stop
	})
	if !errors.Is(err, stop) || n != 1 {
		t.Fatalf("err = %v, calls = %d", err, n)
	}
}

func TestReadRejectsLegacyXLS(t *testing.T) {
	data := append([]byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}, make([]byte, 64)...)
	if _, err := readAll(t, data, 10); !errors.Is(err, domain.ErrUnsupportedMedia) {
		t.Fatalf("got %v", err)
	}
}

func TestReadCorruptXLSXIsValidationError(t *testing.T) {
	_, err := readAll(t, []byte("PK\x03\x04 not really a zip"), 10)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("got %v", err)
	}
}

func TestReadHugeLineRejected(t *testing.T) {
	data := []byte("name\n" + strings.Repeat("x", maxCSVRecordBytes+10))
	if _, err := readAll(t, data, 10); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("got %v", err)
	}
}

func TestXLSXRoundTrip(t *testing.T) {
	in := []domain.Participant{
		{Number: 1, Name: "Азам Турсунов", Phone: "+998 90 123-45-67"},
		{Number: 2, Name: "=HYPERLINK(\"x\")", Phone: "-1"},
		{Number: 3},
	}
	var buf bytes.Buffer
	if err := (Codec{}).Write(&buf, FormatXLSX, in); err != nil {
		t.Fatal(err)
	}
	got, err := readAll(t, buf.Bytes(), 100)
	if err != nil {
		t.Fatal(err)
	}
	want := []row{{2, "Азам Турсунов", "+998 90 123-45-67"}, {3, "=HYPERLINK(\"x\")", "-1"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestXLSXFormulaStaysText(t *testing.T) {
	var buf bytes.Buffer
	if err := (Codec{}).Write(&buf, FormatXLSX, []domain.Participant{{Number: 1, Name: "=1+1"}}); err != nil {
		t.Fatal(err)
	}
	f, err := excelize.OpenReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	formula, err := f.GetCellFormula("Sheet1", "B2")
	if err != nil {
		t.Fatal(err)
	}
	if formula != "" {
		t.Fatalf("name was written as a formula: %q", formula)
	}
	if v, _ := f.GetCellValue("Sheet1", "A1"); v != "number" {
		t.Fatalf("header A1 = %q", v)
	}
}

func TestReadXLSXKeepsLongNumbersAndSkipsGaps(t *testing.T) {
	f := excelize.NewFile()
	cells := map[string]any{
		"A1": "Имя", "B1": "Телефон",
		"A2": "Азам", "B2": 998901234567,
		// row 3 is a gap
		"A4": "Петр", "B4": "+7 926",
	}
	for ref, v := range cells {
		if err := f.SetCellValue("Sheet1", ref, v); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	got, err := readAll(t, buf.Bytes(), 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []row{{2, "Азам", "998901234567"}, {4, "Петр", "+7 926"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCSVWriteReadRoundTrip(t *testing.T) {
	in := []domain.Participant{
		{Number: 1, Name: "Doe; \"John\"", Phone: "+998 90 123-45-67"},
		{Number: 2, Name: "=cmd|' /C calc'!A0", Phone: "+cmd"},
		{Number: 3, Name: "@sum", Phone: "-5"},
	}
	var buf bytes.Buffer
	if err := (Codec{}).Write(&buf, FormatCSV, in); err != nil {
		t.Fatal(err)
	}
	out := buf.Bytes()
	if !bytes.HasPrefix(out, bomUTF8) {
		t.Fatal("CSV must start with a UTF-8 BOM")
	}
	if !strings.Contains(string(out), "number;name;phone\r\n") {
		t.Fatalf("unexpected header: %q", out)
	}
	got, err := readAll(t, out, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d rows", len(got))
	}
	if got[0].name != `Doe; "John"` || got[0].phone != "+998 90 123-45-67" {
		t.Errorf("row 1: %+v", got[0])
	}
	if !strings.HasPrefix(got[1].name, "'=") || !strings.HasPrefix(got[1].phone, "'+") {
		t.Errorf("formula cells were not neutralized: %+v", got[1])
	}
	if !strings.HasPrefix(got[2].name, "'@") || got[2].phone != "-5" {
		// "-5" is phone-like and stays as is.
		t.Errorf("row 3: %+v", got[2])
	}
}

func TestWriteUnknownFormat(t *testing.T) {
	if err := (Codec{}).Write(&bytes.Buffer{}, "pdf", nil); err == nil {
		t.Fatal("expected an error")
	}
}

func TestCSVSafe(t *testing.T) {
	cases := map[string]string{
		"":                  "",
		"plain":             "plain",
		"=1+1":              "'=1+1",
		"@x":                "'@x",
		"+998 90 123-45-67": "+998 90 123-45-67",
		"+cmd":              "'+cmd",
		"-1":                "-1",
		"-abc":              "'-abc",
		"\tx":               "'\tx",
	}
	for in, want := range cases {
		if got := csvSafe(in); got != want {
			t.Errorf("csvSafe(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDecodeTextLargeUTF8CutAtSampleBoundary(t *testing.T) {
	// A multi-byte rune straddling the sample boundary must not flip the file to Windows-1251.
	prefix := strings.Repeat("a", sampleSize-1)
	data := []byte("name\n" + prefix + "ы\n")
	got, err := readAll(t, data, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.HasSuffix(got[0].name, "ы") {
		t.Fatalf("rune corrupted at the sample boundary: %v", got)
	}
}

func BenchmarkReadCSV20k(b *testing.B) {
	var sb strings.Builder
	sb.WriteString("number;name;phone\n")
	for i := range 20000 {
		fmt.Fprintf(&sb, "%d;Participant %d;+998901%06d\n", i, i, i)
	}
	data := []byte(sb.String())
	b.ResetTimer()
	for range b.N {
		_ = Codec{}.Read(bytes.NewReader(data), 20000, func(int, string, string) error { return nil })
	}
}
