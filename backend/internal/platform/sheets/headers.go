// Package sheets reads and writes participant tables as XLSX and CSV.
//
// The pure helpers (header detection, delimiter detection, text decoding, cell cleaning) are
// separated from the I/O so they are cheap to test. The package imports the domain only.
package sheets

import (
	"strings"
	"unicode"
)

// column identifies a logical participant column.
type column int

const (
	colNumber column = iota
	colName
	colPhone
)

// headerNames lists the accepted header spellings per column after normalizeHeader. Russian,
// Uzbek (Cyrillic and Latin) and English names are accepted.
var headerNames = map[column][]string{
	colNumber: {
		"number", "no", "num", "id", "#", "n", "№", "nomer", "raqam", "tartib raqami",
		"номер", "н", "рақам", "тартиб рақами", "п п", "пп", "порядковый номер",
	},
	colName: {
		"name", "full name", "fullname", "full_name", "fio", "fish", "f i sh", "ism", "ismi", "ism familiya",
		"familiya ism", "ismi sharifi", "participant", "client", "customer",
		"имя", "фио", "ф и о", "фамилия имя", "фамилия имя отчество", "имя фамилия", "участник", "клиент",
		"исм", "фиш", "ф и ш", "исм шарифи", "исми шарифи",
	},
	colPhone: {
		"phone", "phone number", "phonenumber", "tel", "telephone", "mobile", "cell", "contact",
		"telefon", "telefon raqami", "telefon raqam", "tel raqam", "tel raqami",
		"телефон", "тел", "номер телефона", "мобильный", "моб", "контакт", "контактный телефон",
		"телефон рақами", "тел рақами", "телефон рақам",
	},
}

var headerIndex = func() map[string]column {
	m := make(map[string]column)
	for c, names := range headerNames {
		for _, n := range names {
			m[n] = c
		}
	}
	return m
}()

// normalizeHeader lowercases a header cell, folds yo to ye, turns punctuation into single spaces
// and trims, so "Ф.И.О." and "ф и о" compare equal. The "№" and "#" signs are kept.
func normalizeHeader(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	space := false
	for _, r := range s {
		if r == 'ё' {
			r = 'е'
		}
		if strings.ContainsRune("ʻ'`’‘", r) {
			continue // o'zbek, o‘zbek: apostrophes carry no meaning here
		}
		if r == '№' || r == '#' || unicode.IsLetter(r) || unicode.IsDigit(r) {
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteRune(r)
			space = false
			continue
		}
		space = true
	}
	return b.String()
}

// columnMap holds the zero-based index of each logical column in a row, or -1 when absent.
type columnMap struct {
	number, name, phone int
}

// detectHeader inspects a first row. When at least one cell is a known name or phone header it
// reports the mapping and true; otherwise the row is data and the caller falls back to
// positionalColumns.
func detectHeader(row []string) (columnMap, bool) {
	m := columnMap{number: -1, name: -1, phone: -1}
	found := false
	for i, cell := range row {
		c, ok := headerIndex[normalizeHeader(cell)]
		if !ok {
			continue
		}
		switch c {
		case colNumber:
			if m.number < 0 {
				m.number = i
			}
		case colName:
			if m.name < 0 {
				m.name = i
			}
			found = true
		case colPhone:
			if m.phone < 0 {
				m.phone = i
			}
			found = true
		}
	}
	return m, found
}

// positionalColumns maps a headerless table by width: three or more columns are number, name,
// phone (the export layout); two are name, phone; one is name.
func positionalColumns(width int) columnMap {
	switch {
	case width >= 3:
		return columnMap{number: 0, name: 1, phone: 2}
	case width == 2:
		return columnMap{number: -1, name: 0, phone: 1}
	default:
		return columnMap{number: -1, name: 0, phone: -1}
	}
}

// cleanCell makes a cell safe to store: invalid UTF-8 becomes U+FFFD, control characters (NUL
// included, which PostgreSQL rejects) are dropped, line breaks and tabs become spaces, and the
// result is trimmed.
func cleanCell(s string) string {
	s = strings.ToValidUTF8(s, "�")
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case unicode.IsSpace(r) || r == 0xA0:
			b.WriteByte(' ')
		case unicode.IsControl(r) || r == 0xFEFF:
			// dropped
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// cell returns row[i] cleaned, or "" when i is out of range or negative.
func cell(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return cleanCell(row[i])
}

// rowEmpty reports whether every cell of the row is blank.
func rowEmpty(row []string) bool {
	for _, c := range row {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}
