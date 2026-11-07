package logging

import (
	"fmt"
	"log"
	"strings"

	"github.com/rs/zerolog"
)

type stdWriter struct{ l zerolog.Logger }

func (w stdWriter) Write(p []byte) (int, error) {
	w.l.Warn().Msg(strings.TrimSpace(string(p)))
	return len(p), nil
}

// NewStdLogger returns a standard library logger that forwards to l at WARN level.
// Use it for http.Server.ErrorLog.
func NewStdLogger(l zerolog.Logger, component string) *log.Logger {
	return log.New(stdWriter{l.With().Str(FieldComponent, component).Logger()}, "", 0)
}

// Goose adapts a zerolog logger to goose.Logger.
type Goose struct{ L zerolog.Logger }

// Printf logs migration progress at INFO.
func (g Goose) Printf(format string, v ...any) {
	g.L.Info().Str(FieldComponent, "goose").Msg(strings.TrimSpace(fmt.Sprintf(format, v...)))
}

// Fatalf logs at ERROR and, unlike the default goose logger, does not exit the process.
func (g Goose) Fatalf(format string, v ...any) {
	g.L.Error().Str(FieldComponent, "goose").Msg(strings.TrimSpace(fmt.Sprintf(format, v...)))
}
