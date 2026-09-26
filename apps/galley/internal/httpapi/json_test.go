package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type requestBodyCase struct {
	name        string
	method      string
	url         string
	valid       string
	caseVariant string
	property    string
}

func createRequestBodyCases(t *testing.T, baseURL string, client *http.Client) []requestBodyCase {
	t.Helper()
	updated := createTicket(t, client, baseURL, uniqueTitle(t))
	transitioned := createTicket(t, client, baseURL, uniqueTitle(t))
	return []requestBodyCase{
		{"create ticket", http.MethodPost, baseURL + "/api/tickets", `{"title":"` + uniqueTitle(t) + `"}`, `{"TiTlE":"` + uniqueTitle(t) + `"}`, "TiTlE"},
		{"update ticket", http.MethodPatch, baseURL + "/api/tickets/" + updated.Id, `{"successCriteria":"done"}`, `{"SUCCESSCRITERIA":"done"}`, "SUCCESSCRITERIA"},
		{"change status", http.MethodPost, baseURL + "/api/tickets/" + transitioned.Id + "/status", `{"status":"Ready"}`, `{"STATUS":"Ready"}`, "STATUS"},
		{"create diagnostic note", http.MethodPost, baseURL + "/api/dev/diagnostic-notes", `{"note":"` + uniqueNote(t) + `"}`, `{"NOTE":"` + uniqueNote(t) + `"}`, "NOTE"},
	}
}

func assertInvalidRequestBody(t *testing.T, client *http.Client, tc requestBodyCase, body, property string) {
	t.Helper()
	req, err := http.NewRequest(tc.method, tc.url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read response: %v", err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", resp.StatusCode, data)
	}
	var result ErrorBody
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("failed to decode error body %q: %v", data, err)
	}
	if result.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want invalid_request", result.Error.Code)
	}
	if property != "" && !strings.Contains(result.Error.Message, `"`+property+`"`) {
		t.Errorf("Error.Message = %q, want property %q", result.Error.Message, property)
	}
}

func TestRequestBodies_RejectCaseVariantProperties(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	for _, tc := range createRequestBodyCases(t, baseURL, client) {
		t.Run(tc.name, func(t *testing.T) {
			assertInvalidRequestBody(t, client, tc, tc.caseVariant, tc.property)
		})
	}
}

func TestRequestBodies_RejectTrailingContent(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	for _, suffix := range []struct{ name, value string }{
		{"second JSON value", ` {"ignored":true}`},
		{"non-JSON suffix", ` !`},
	} {
		t.Run(suffix.name, func(t *testing.T) {
			for _, tc := range createRequestBodyCases(t, baseURL, client) {
				t.Run(tc.name, func(t *testing.T) {
					assertInvalidRequestBody(t, client, tc, tc.valid+suffix.value, "")
				})
			}
		})
	}
}

func TestDecodeStrictJSON_AllowsTrailingWhitespace(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/tickets", strings.NewReader("{\"title\":\"ok\"} \n\t"))
	rec := httptest.NewRecorder()
	var dst CreateTicketRequest
	if !decodeStrictJSON(rec, req, &dst, "invalid ticket") {
		t.Fatalf("valid body rejected: %s", rec.Body.String())
	}
	if dst.Title != "ok" {
		t.Errorf("Title = %q, want ok", dst.Title)
	}
}
