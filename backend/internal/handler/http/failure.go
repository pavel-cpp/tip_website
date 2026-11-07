package http

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/pavel-cpp/tip_website/backend/internal/domain"
	"github.com/pavel-cpp/tip_website/backend/internal/platform/logging"
)

// statusByCode maps the stable domain error codes to HTTP statuses (docs/04-api.md, section 1).
var statusByCode = map[domain.Code]int{
	domain.CodeValidation:        http.StatusBadRequest,
	domain.CodeUnauthenticated:   http.StatusUnauthorized,
	domain.CodeTokenExpired:      http.StatusUnauthorized,
	domain.CodeTokenStale:        http.StatusUnauthorized,
	domain.CodeRefreshInvalid:    http.StatusUnauthorized,
	domain.CodeBadCredentials:    http.StatusUnauthorized,
	domain.CodeAuthUnavailable:   http.StatusServiceUnavailable,
	domain.CodeForbidden:         http.StatusForbidden,
	domain.CodePasswordChangeReq: http.StatusForbidden,
	domain.CodeNotFound:          http.StatusNotFound,
	domain.CodeRowLocked:         http.StatusConflict,
	domain.CodeVersionConflict:   http.StatusConflict,
	domain.CodeProjectFinished:   http.StatusConflict,
	domain.CodeLastAdmin:         http.StatusConflict,
	domain.CodeRoleInUse:         http.StatusConflict,
	domain.CodeRoleSystem:        http.StatusConflict,
	domain.CodeTooLarge:          http.StatusRequestEntityTooLarge,
	domain.CodeUnsupportedMedia:  http.StatusUnsupportedMediaType,
	domain.CodeImageInvalid:      http.StatusUnprocessableEntity,
	domain.CodeRateLimited:       http.StatusTooManyRequests,
	domain.CodeDiskLow:           http.StatusInsufficientStorage,
	domain.CodeInternal:          http.StatusInternalServerError,
}

// fail writes the error envelope for err and logs it exactly once, so services and repositories
// never log. Unknown errors become INTERNAL with a generic message: their text may contain
// SQL or personal data and must not reach the client.
func fail(w http.ResponseWriter, r *http.Request, err error) {
	code := domain.CodeOf(err)
	status, known := statusByCode[code]
	if !known {
		code, status = domain.CodeInternal, http.StatusInternalServerError
	}

	message := err.Error()
	var details map[string]any
	if code == domain.CodeInternal {
		message = "internal server error (request id: " + RequestID(r.Context()) + ")"
	} else {
		details = detailsOf(err)
	}

	if d, ok := details["retryAfter"].(time.Duration); ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(d.Seconds()))))
		details["retryAfterSeconds"] = int(math.Ceil(d.Seconds()))
		delete(details, "retryAfter")
	}

	l := logging.FromContext(r.Context())
	if status >= http.StatusInternalServerError && code != domain.CodeAuthUnavailable {
		l.Error().Err(err).Str("code", string(code)).Msg("request failed")
	} else {
		l.Debug().Err(err).Str("code", string(code)).Msg("request rejected")
	}

	var out any
	if details != nil {
		out = details
	}
	writeError(w, status, string(code), message, out)
}

// detailsOf extracts the client-visible structured context of a domain error.
func detailsOf(err error) map[string]any {
	var ve *domain.ValidationError
	if errors.As(err, &ve) {
		fields := make([]map[string]string, len(ve.Fields))
		for i, f := range ve.Fields {
			fields[i] = map[string]string{"field": f.Field, "reason": f.Reason}
		}
		return map[string]any{"fields": fields}
	}
	var de *domain.Error
	if errors.As(err, &de) && len(de.Details) > 0 {
		out := make(map[string]any, len(de.Details))
		for k, v := range de.Details {
			out[k] = v
		}
		return out
	}
	return nil
}
