package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// TestCreateTicket_DefaultsTemplateToBasicWithHumanAcceptance is issue
// #59's quick-capture requirement: a title alone still captures a
// Ticket, and when template is absent it defaults to Basic with the
// human-acceptance completion condition -- docs/ticket-creation.md's
// "Basic: ... completion through human acceptance."
func TestCreateTicket_DefaultsTemplateToBasicWithHumanAcceptance(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	created := createTicket(t, client, baseURL, uniqueTitle(t))

	if created.Template != Basic {
		t.Errorf("Template = %q, want %q", created.Template, Basic)
	}
	if created.CompletionCondition != HumanAcceptance {
		t.Errorf("CompletionCondition = %q, want %q", created.CompletionCondition, HumanAcceptance)
	}
	if created.Repository != "" {
		t.Errorf("Repository = %q, want \"\" (never set)", created.Repository)
	}
}

// TestCreateTicket_CodingTemplateDefaultsToReviewedPrMerge is the
// Coding Template's own default (docs/ticket-creation.md: "Coding: ...
// completion through merging the reviewed PR"), and proves a title
// alone is sufficient for it too -- D3 draws no distinction in what
// quick capture requires between Templates.
func TestCreateTicket_CodingTemplateDefaultsToReviewedPrMerge(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	created := createTicketWithTemplate(t, client, baseURL, uniqueTitle(t), Coding)

	if created.Template != Coding {
		t.Errorf("Template = %q, want %q", created.Template, Coding)
	}
	if created.CompletionCondition != ReviewedPrMerge {
		t.Errorf("CompletionCondition = %q, want %q", created.CompletionCondition, ReviewedPrMerge)
	}
}

// TestCreateTicket_RejectsInvalidTemplate proves an unrecognized
// template value is rejected rather than silently defaulted or stored
// verbatim -- template stays a closed, two-value set (Basic, Coding),
// not an open string a client could invent a third value for.
func TestCreateTicket_RejectsInvalidTemplate(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/tickets",
		strings.NewReader(`{"title":"bad template test","template":"Coding "}`))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST /api/tickets failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusBadRequest)
	}
	var errBody ErrorBody
	if err := json.NewDecoder(resp.Body).Decode(&errBody); err != nil {
		t.Fatalf("failed to decode error body: %v", err)
	}
	if errBody.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "invalid_request")
	}
}

// TestUpdateTicket_RejectsTemplateChange is issue #59's own required
// limitation: changing a Ticket's Template after creation is out of
// scope for M2 (D4, owned by M8). Naming "template" in a PATCH body at
// all -- even the Ticket's own current value -- is rejected outright,
// and nothing about the Ticket (including completionCondition) changes
// as a result.
func TestUpdateTicket_RejectsTemplateChange(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	cases := []struct {
		name     string
		template TicketTemplate
	}{
		{"to a different value", Coding},
		{"to its own current value", Basic},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Template: &tc.template})
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusBadRequest, body)
			}
			var errBody ErrorBody
			if err := json.Unmarshal(body, &errBody); err != nil {
				t.Fatalf("failed to decode error body %q: %v", body, err)
			}
			if errBody.Error.Code != "invalid_request" {
				t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "invalid_request")
			}
		})
	}

	got := getTicketAssertOK(t, client, baseURL, created.Id)
	if got.Template != Basic {
		t.Errorf("Template = %q after rejected change attempts, want unchanged %q", got.Template, Basic)
	}
	if got.CompletionCondition != HumanAcceptance {
		t.Errorf("CompletionCondition = %q after rejected template-change attempts, want unchanged %q", got.CompletionCondition, HumanAcceptance)
	}
}

// TestUpdateTicket_CompletionConditionNeverChanges is this slice's
// central, explicitly required acceptance test (issue #59: "the
// completion condition does not change when other fields change"),
// including across a Galley restart -- see
// cmd/galley's TestRestartDurability_CompletionConditionSurvivesFreshProcess
// for the restart half. This proves it at the single-process level for
// both Templates: every other field this endpoint accepts is patched,
// individually and in combination, and completionCondition is read
// back unchanged after each one.
//
// This is deliberately a behavioral proof, not a structural one: it
// would fail immediately if a future change made UpdateTicket (or
// updateTicketForOwner's SQL) recompute or overwrite the column for
// any reason, regardless of how that regression was introduced.
func TestUpdateTicket_CompletionConditionNeverChanges(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	cases := []struct {
		template TicketTemplate
		wantCond TicketCompletionCondition
	}{
		{Basic, HumanAcceptance},
		{Coding, ReviewedPrMerge},
	}
	for _, tc := range cases {
		t.Run(string(tc.template), func(t *testing.T) {
			created := createTicketWithTemplate(t, client, baseURL, uniqueTitle(t), tc.template)
			if created.CompletionCondition != tc.wantCond {
				t.Fatalf("CompletionCondition at creation = %q, want %q", created.CompletionCondition, tc.wantCond)
			}

			edits := []UpdateTicketRequest{
				{Title: strPtr(uniqueTitle(t) + "-edit1")},
				{Goal: strPtr("Ship the feature")},
				{Context: strPtr("Some background")},
				{SuccessCriteria: strPtr("Tests pass")},
				{Constraints: strPtr("Do not change the API")},
				{Repository: strPtr("owner/repo")},
				// Clearing every refinement field back out is itself a
				// field-changing PATCH and must not touch it either.
				{Goal: strPtr(""), Context: strPtr(""), SuccessCriteria: strPtr(""), Constraints: strPtr(""), Repository: strPtr("")},
				// An empty-bodied PATCH (still a write -- it bumps
				// updated_at) must not touch it.
				{},
			}
			for i, edit := range edits {
				resp, body := patchTicket(t, client, baseURL, created.Id, edit)
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("edit %d: PATCH status = %d, want %d; body=%s", i, resp.StatusCode, http.StatusOK, body)
				}
				var updated Ticket
				if err := json.Unmarshal(body, &updated); err != nil {
					t.Fatalf("edit %d: failed to decode response %q: %v", i, body, err)
				}
				if updated.CompletionCondition != tc.wantCond {
					t.Errorf("edit %d: CompletionCondition = %q, want unchanged %q", i, updated.CompletionCondition, tc.wantCond)
				}
				if updated.Template != tc.template {
					t.Errorf("edit %d: Template = %q, want unchanged %q", i, updated.Template, tc.template)
				}
			}

			final := getTicketAssertOK(t, client, baseURL, created.Id)
			if final.CompletionCondition != tc.wantCond {
				t.Errorf("final CompletionCondition = %q, want unchanged %q", final.CompletionCondition, tc.wantCond)
			}
		})
	}
}

// insertTicketWithMismatchedCompletionCondition inserts a row directly
// (bypassing CreateTicket, like ticket_test.go's insertTicketAt) whose
// stored completion_condition deliberately does NOT match what
// defaultCompletionCondition(template) would produce for that template.
// No legitimate path through this API can ever create such a row --
// template is fixed at creation and completion_condition is derived
// from it exactly once, by construction. This exists solely so
// TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate below
// can tell "genuinely untouched" apart from "recomputed but happens to
// match" -- every other test in this file uses a real template/condition
// pairing, which a recompute-from-template bug would satisfy by sheer
// coincidence (template never changes in this API), silently defeating
// the guardrail.
func insertTicketWithMismatchedCompletionCondition(t *testing.T, pool *pgxpool.Pool, ownerID int64, title string, template TicketTemplate, mismatchedCondition TicketCompletionCondition) (publicID string) {
	t.Helper()
	publicID = uuid.NewString()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO tickets (owner_id, title, status, public_id, template, completion_condition, created_at, updated_at)
		 VALUES ($1, $2, $3, $4::uuid, $5, $6, now(), now())`,
		ownerID, title, string(Backlog), publicID, string(template), string(mismatchedCondition),
	)
	if err != nil {
		t.Fatalf("failed to insert fixture ticket with a mismatched completion condition: %v", err)
	}
	return publicID
}

// TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate is the
// stronger version of TestUpdateTicket_CompletionConditionNeverChanges:
// it starts from a row whose stored completion_condition deliberately
// disagrees with its template (a state no legitimate Create/Update call
// can produce), then PATCHes an unrelated field. If UpdateTicket or
// updateTicketForOwner ever looked at the Ticket's template to decide
// completionCondition -- the exact regression D3 forbids -- this
// mismatched value would be "corrected" back to the template's default,
// which is observably different from the stored value and fails this
// test immediately. TestUpdateTicket_CompletionConditionNeverChanges
// alone cannot catch this: every ticket it constructs has template and
// completion_condition already in agreement (the only pairing
// CreateTicket can ever produce), so a recompute-from-template bug
// would reproduce the same value there by coincidence.
func TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate(t *testing.T) {
	pool := postgres.NewTestPool(t)
	baseURL, client := devServerWithSessionForTickets(t)
	ownerID := resolveTestOwner(t, pool)

	// Coding's real default is reviewedPrMerge -- store humanAcceptance
	// instead, the mismatch a recompute would "fix".
	publicID := insertTicketWithMismatchedCompletionCondition(t, pool, ownerID, uniqueTitle(t), Coding, HumanAcceptance)

	resp, body := patchTicket(t, client, baseURL, publicID, UpdateTicketRequest{Goal: strPtr("Ship it")})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	if updated.CompletionCondition != HumanAcceptance {
		t.Errorf(
			"CompletionCondition = %q after an unrelated PATCH, want it to stay the deliberately mismatched %q -- "+
				"it changed to %q, which is exactly template Coding's own default: this PATCH recomputed "+
				"completionCondition from the Ticket's template instead of leaving the stored value alone",
			updated.CompletionCondition, HumanAcceptance, updated.CompletionCondition,
		)
	}
	if updated.Template != Coding {
		t.Errorf("Template = %q, want unchanged %q", updated.Template, Coding)
	}

	got := getTicketAssertOK(t, client, baseURL, publicID)
	if got.CompletionCondition != HumanAcceptance {
		t.Errorf("CompletionCondition on re-fetch = %q, want it to stay %q", got.CompletionCondition, HumanAcceptance)
	}
}
