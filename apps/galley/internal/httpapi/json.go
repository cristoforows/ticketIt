package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
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

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, dst any, shapeMessage string) bool {
	dec := json.NewDecoder(r.Body)
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", shapeMessage)
		return false
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_request", shapeMessage)
		return false
	}

	var properties map[string]json.RawMessage
	if err := json.Unmarshal(raw, &properties); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", shapeMessage)
		return false
	}
	allowed := make(map[string]bool)
	typ := reflect.TypeOf(dst).Elem()
	for i := 0; i < typ.NumField(); i++ {
		name, _, _ := strings.Cut(typ.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			allowed[name] = true
		}
	}
	for name := range properties {
		if !allowed[name] {
			writeError(w, http.StatusBadRequest, "invalid_request",
				`unknown request property "`+name+`" -- `+shapeMessage)
			return false
		}
	}

	strict := json.NewDecoder(bytes.NewReader(raw))
	strict.DisallowUnknownFields()
	err := strict.Decode(dst)
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
