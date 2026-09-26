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

func TestDecodeStrictJSON_RejectsNull(t *testing.T) {
	cases := []struct {
		name string
		body string
		dst  any
	}{
		{"top-level", `null`, &UpdateTicketRequest{}},
		{"create title", `{"title":null}`, &CreateTicketRequest{}},
		{"create template", `{"title":"ok","template":null}`, &CreateTicketRequest{}},
		{"patch title", `{"title":null}`, &UpdateTicketRequest{}},
		{"patch template", `{"template":null}`, &UpdateTicketRequest{}},
		{"patch optional field", `{"goal":null}`, &UpdateTicketRequest{}},
		{"duplicate property", `{"title":null,"title":"ok"}`, &UpdateTicketRequest{}},
		{"spaced null", `{"title": null }`, &UpdateTicketRequest{}},
		{"status", `{"status":null}`, &ChangeTicketStatusRequest{}},
		{"diagnostic note", `{"note":null}`, &CreateDiagnosticNoteRequest{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			if decodeStrictJSON(rec, req, tc.dst, "invalid body") {
				t.Fatal("accepted null body/property")
			}
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
			var result ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || result.Error.Code != "invalid_request" {
				t.Fatalf("response = %s, decode error = %v", rec.Body.String(), err)
			}
		})
	}
}

func TestDecodeStrictJSON_AllowsEmptyObject(t *testing.T) {
	req := httptest.NewRequest(http.MethodPatch, "/api/tickets/id", strings.NewReader(" \n{} \t"))
	rec := httptest.NewRecorder()
	var dst UpdateTicketRequest
	if !decodeStrictJSON(rec, req, &dst, "invalid body") {
		t.Fatalf("empty object rejected: %s", rec.Body.String())
	}
}

func TestUpdateTicket_RejectsNullTemplateAndTitleOverHTTP(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))
	for _, body := range []string{`{"template":null}`, `{"title":null}`} {
		t.Run(body, func(t *testing.T) {
			assertInvalidRequestBody(t, client, requestBodyCase{method: http.MethodPatch, url: baseURL + "/api/tickets/" + created.Id}, body, "")
		})
	}
	got := getTicketAssertOK(t, client, baseURL, created.Id)
	if got.Title != created.Title || got.Template != created.Template {
		t.Errorf("ticket changed after rejected PATCH: %+v", got)
	}
}
