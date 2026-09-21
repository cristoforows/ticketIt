package httpapi

import "encoding/json"

// ErrorBody is the shared JSON error shape returned by every Galley
// error response. Later slices reuse this exact shape; see
// apps/galley/README.md ("Error shape") before introducing a different
// one.
type ErrorBody struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail carries a machine-readable code and a human-readable
// message. Codes are short, stable, snake_case identifiers (e.g.
// "not_found", "method_not_allowed") that callers can match on without
// parsing the message text.
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func newErrorBody(code, message string) ErrorBody {
	return ErrorBody{Error: ErrorDetail{Code: code, Message: message}}
}

// mustMarshalFallback is used only if json.Marshal of our own static
// error types somehow fails; it hand-writes the same shape so a caller
// never sees a broken response body.
func fallbackErrorJSON() []byte {
	b, err := json.Marshal(newErrorBody("internal_error", "failed to encode error response"))
	if err != nil {
		// Truly last resort: a hand-written literal matching the shape above.
		return []byte(`{"error":{"code":"internal_error","message":"failed to encode error response"}}`)
	}
	return b
}
