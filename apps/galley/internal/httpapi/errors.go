package httpapi

import "encoding/json"

// ErrorBody and ErrorDetail (generated from contracts/openapi.yaml) are
// the shared shape of every Galley error response, including ones with
// no operation of their own. Codes are short, stable, snake_case
// identifiers callers can match on without parsing the message. See
// README.md ("Error shape") before introducing a different one.

func newErrorBody(code, message string) ErrorBody {
	return ErrorBody{Error: ErrorDetail{Code: code, Message: message}}
}

// fallbackErrorJSON covers the impossible case of json.Marshal failing
// on our own static error types, so a caller never sees a broken body.
func fallbackErrorJSON() []byte {
	b, err := json.Marshal(newErrorBody("internal_error", "failed to encode error response"))
	if err != nil {
		// Truly last resort: a hand-written literal matching the shape above.
		return []byte(`{"error":{"code":"internal_error","message":"failed to encode error response"}}`)
	}
	return b
}
