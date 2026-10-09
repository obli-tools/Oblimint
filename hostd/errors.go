package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
)

// Error codes returned in {"ok":false,"error":"...","code":"..."}. The panel
// client (server/src/services/hostd/client.ts) surfaces them as HostdError.code.
const (
	codeInvalid     = "invalid"     // 400: bad id / slug / path / body
	codeNotFound    = "notFound"    // 404: the account / site tree does not exist
	codeUnsafePath  = "unsafePath"  // 409: a symlink or non-directory sits on the path
	codeBusy        = "busy"        // 409: another operation holds the account (retry later)
	codeUnsupported = "unsupported" // 501: not available on this OS / filesystem
	codeCancelled   = "cancelled"   // 503: the caller left (timeout): the operation stopped part way
	codeInternal    = "internal"    // 500
)

// apiError is an error carrying its HTTP status and code.
type apiError struct {
	Status int
	Code   string
	Msg    string
}

func (e *apiError) Error() string { return e.Msg }

func badRequest(format string, args ...any) error {
	return &apiError{http.StatusBadRequest, codeInvalid, fmt.Sprintf(format, args...)}
}

// busy: the account lock could not be taken in time (or the caller left).
func busy(format string, args ...any) error {
	return &apiError{http.StatusConflict, codeBusy, fmt.Sprintf(format, args...)}
}

func notFound(format string, args ...any) error {
	return &apiError{http.StatusNotFound, codeNotFound, fmt.Sprintf(format, args...)}
}

// errUnsafePath is wrapped by every refusal to traverse a symlink / non-directory.
var errUnsafePath = errors.New("unsafe path")

func unsafePath(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errUnsafePath, fmt.Sprintf(format, args...))
}

// classify maps any error to (status, code).
func classify(err error) (int, string) {
	var ae *apiError
	switch {
	case errors.As(err, &ae):
		return ae.Status, ae.Code
	case errors.Is(err, errUnsafePath):
		return http.StatusConflict, codeUnsafePath
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return http.StatusServiceUnavailable, codeCancelled
	case errors.Is(err, errUnsupported):
		return http.StatusNotImplemented, codeUnsupported
	case errors.Is(err, fs.ErrNotExist):
		return http.StatusNotFound, codeNotFound
	default:
		return http.StatusInternalServerError, codeInternal
	}
}
