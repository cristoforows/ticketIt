package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
)

// writeJSON encodes v to a buffer first so a marshal failure never
// results in a half-written body with an already-sent status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write(fallbackErrorJSON())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, newErrorBody(code, message))
}

// unknownFieldPrefix is encoding/json's own DisallowUnknownFields
// error text (decode.go, unexported and untyped -- there is no
// *json.UnknownFieldError to errors.As against), stable since Go 1.10.
const unknownFieldPrefix = `json: unknown field "`

// decodeStrictJSON is every request-body decode site's one entry
// point (issue #75): contracts/openapi.yaml declares
// additionalProperties: false on every request schema, which a plain
// json.Decoder does not enforce on its own. shapeMessage is the
// caller's existing malformed-body message, reused unchanged for any
// decode failure that is not an unknown property so that behavior does
// not change; an unknown property instead names itself, since a
// misspelled field is otherwise indistinguishable from one silently
// dropped -- but never the underlying "json: ..." text verbatim, which
// is an encoding/json implementation detail, not a stable API surface.
func decodeStrictJSON(w http.ResponseWriter, r *http.Request, dst any, shapeMessage string) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if err == nil {
		return true
	}
	if rest, ok := strings.CutPrefix(err.Error(), unknownFieldPrefix); ok {
		field := strings.TrimSuffix(rest, `"`)
		writeError(w, http.StatusBadRequest, "invalid_request",
			`unknown request property "`+field+`" -- `+shapeMessage)
		return false
	}
	writeError(w, http.StatusBadRequest, "invalid_request", shapeMessage)
	return false
}
