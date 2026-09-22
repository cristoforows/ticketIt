package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/authtest"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// devServerWithSessionAndPoolForTickets mirrors
// devServerWithSessionForTickets (ticket_test.go), additionally
// exposing the real pool and the resolved owner id -- this file's
// fixtures need to force a Ticket into an arbitrary starting Status
// directly (setTicketStatusDirect below), which the HTTP API itself
// has no way to do (that is exactly the state machine under test).
func devServerWithSessionAndPoolForTickets(t *testing.T) (baseURL string, client *http.Client, pool *pgxpool.Pool, ownerID int64) {
	t.Helper()
	pool = postgres.NewTestPool(t)
	fake := githubfake.New(t, githubfake.TestOwnerIdentity)
	srv, _ := startTestGalley(t, pool, config.EnvDevelopment, fake)
	client = authtest.NewClient()
	authtest.SignIn(t, client, srv.URL)
	ownerID = resolveTestOwner(t, pool)
	return srv.URL, client, pool, ownerID
}

// setTicketStatusDirect forces a Ticket's persisted Status directly,
// bypassing every transition rule this slice adds -- the only way to
// construct an arbitrary (fixture) starting state for the transition
// table test below, exactly like insertTicketAt bypasses insertTicket
// for issue #59's mismatched-fixture test.
func setTicketStatusDirect(t *testing.T, pool *pgxpool.Pool, ownerID int64, publicID string, status TicketStatus) {
	t.Helper()
	tag, err := pool.Exec(context.Background(),
		`UPDATE tickets SET status = $3 WHERE owner_id = $1 AND public_id = $2::uuid`,
		ownerID, publicID, string(status),
	)
	if err != nil {
		t.Fatalf("failed to force fixture status %s: %v", status, err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("failed to force fixture status %s: %d rows affected, want 1", status, tag.RowsAffected())
	}
}

// lifecycleResult is the decoded outcome of one lifecycle HTTP call:
// either a 2xx Ticket body or a non-2xx ErrorBody, never both.
type lifecycleResult struct {
	status  int
	ticket  Ticket
	errBody ErrorBody
}

func doLifecycleRequest(t *testing.T, client *http.Client, method, url string, body any) lifecycleResult {
	t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("failed to marshal request body: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s failed: %v", method, url, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read response body: %v", err)
	}

	result := lifecycleResult{status: resp.StatusCode}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if len(data) > 0 {
			if err := json.Unmarshal(data, &result.ticket); err != nil {
				t.Fatalf("failed to decode ticket response %q: %v", data, err)
			}
		}
		return result
	}
	if err := json.Unmarshal(data, &result.errBody); err != nil {
		t.Fatalf("failed to decode error response %q: %v", data, err)
	}
	return result
}

func changeStatus(t *testing.T, client *http.Client, baseURL, id string, status TicketStatus) lifecycleResult {
	t.Helper()
	return doLifecycleRequest(t, client, http.MethodPost, baseURL+"/api/tickets/"+id+"/status", ChangeTicketStatusRequest{Status: status})
}

func acceptTicketHTTP(t *testing.T, client *http.Client, baseURL, id string) lifecycleResult {
	t.Helper()
	return doLifecycleRequest(t, client, http.MethodPost, baseURL+"/api/tickets/"+id+"/accept", nil)
}

func assignOwnerHTTP(t *testing.T, client *http.Client, baseURL, id string) lifecycleResult {
	t.Helper()
	return doLifecycleRequest(t, client, http.MethodPut, baseURL+"/api/tickets/"+id+"/assignee", nil)
}

func unassignHTTP(t *testing.T, client *http.Client, baseURL, id string) lifecycleResult {
	t.Helper()
	return doLifecycleRequest(t, client, http.MethodDelete, baseURL+"/api/tickets/"+id+"/assignee", nil)
}

func getTicketHTTP(t *testing.T, client *http.Client, baseURL, id string) Ticket {
	t.Helper()
	resp, err := client.Get(baseURL + "/api/tickets/" + id)
	if err != nil {
		t.Fatalf("GET /api/tickets/%s failed: %v", id, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/tickets/%s status = %d, want 200; body=%s", id, resp.StatusCode, data)
	}
	var ticket Ticket
	if err := json.Unmarshal(data, &ticket); err != nil {
		t.Fatalf("failed to decode ticket %q: %v", data, err)
	}
	return ticket
}

// allTicketStatuses is every TicketStatus value the contract defines,
// used to build the exhaustive transition-grid test below.
var allTicketStatuses = []TicketStatus{Backlog, Ready, InProgress, Blocked, InReview, Done}

// d3S2AllowedPlainTransitions is D3 S2's human-assigned workflow table
// (docs/decisions/d3-agent-template-compatibility.md), transcribed
// literally and independently of allowedSourceStatusesForTarget in
// ticket_lifecycle.go -- this is the spec the implementation is
// checked against, not a re-statement of the implementation itself.
// In Review -> Done is deliberately absent: D3 permits it only via
// explicit Accept, never a plain status change (see
// TestAcceptTicket_* below for that path).
var d3S2AllowedPlainTransitions = map[[2]TicketStatus]bool{
	{Backlog, Ready}:       true,
	{Ready, Backlog}:       true,
	{Ready, InProgress}:    true,
	{InProgress, Ready}:    true,
	{InProgress, Blocked}:  true,
	{Backlog, Blocked}:     true,
	{Blocked, InProgress}:  true,
	{InProgress, InReview}: true,
	{InReview, InProgress}: true,
	{Done, Ready}:          true,
}

// TestChangeTicketStatus_D3S2Table is the exhaustive proof for POST
// /api/tickets/{id}/status: every one of the 6x6 = 36 (from, to) pairs
// is exercised, each against a Ticket forced (via setTicketStatusDirect)
// into exactly that starting Status. This subsumes every rejection the
// issue names explicitly (Backlog -> InProgress, Backlog -> Done,
// Ready -> InReview, Ready -> Done, a plain status-set to Done from
// any state, and Blocked -> Ready specifically -- D3 permits only
// Blocked -> InProgress) as one of the 27 rejected subtests below,
// rather than duplicating them as separate hand-picked tests.
func TestChangeTicketStatus_D3S2Table(t *testing.T) {
	baseURL, client, pool, ownerID := devServerWithSessionAndPoolForTickets(t)

	for _, from := range allTicketStatuses {
		for _, to := range allTicketStatuses {
			from, to := from, to
			allowed := d3S2AllowedPlainTransitions[[2]TicketStatus{from, to}]
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				created := createTicket(t, client, baseURL, uniqueTitle(t))
				setTicketStatusDirect(t, pool, ownerID, created.Id, from)

				resp := changeStatus(t, client, baseURL, created.Id, to)

				if allowed {
					if resp.status != http.StatusOK {
						t.Fatalf("status = %d, want 200 (allowed transition %s -> %s); error=%+v", resp.status, from, to, resp.errBody)
					}
					if resp.ticket.Status != to {
						t.Errorf("response Status = %q, want %q", resp.ticket.Status, to)
					}
					persisted := getTicketHTTP(t, client, baseURL, created.Id)
					if persisted.Status != to {
						t.Errorf("persisted Status = %q, want %q (transition did not actually apply)", persisted.Status, to)
					}
					return
				}

				if resp.status != http.StatusBadRequest {
					t.Fatalf("status = %d, want 400 (disallowed transition %s -> %s); body=%+v", resp.status, from, to, resp.ticket)
				}
				if resp.errBody.Error.Code != invalidTransitionCode {
					t.Errorf("Error.Code = %q, want %q", resp.errBody.Error.Code, invalidTransitionCode)
				}
				persisted := getTicketHTTP(t, client, baseURL, created.Id)
				if persisted.Status != from {
					t.Errorf("persisted Status = %q, want unchanged %q (rejected transition must not apply)", persisted.Status, from)
				}
			})
		}
	}
}

// TestChangeTicketStatus_RejectsUnknownStatusValue proves the request
// schema's own validation (invalid_request) is distinct from a
// well-formed but disallowed transition (invalid_transition).
func TestChangeTicketStatus_RejectsUnknownStatusValue(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	resp := doLifecycleRequest(t, client, http.MethodPost, baseURL+"/api/tickets/"+created.Id+"/status", map[string]string{"status": "NotARealStatus"})
	if resp.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.status)
	}
	if resp.errBody.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", resp.errBody.Error.Code, "invalid_request")
	}
}

func TestChangeTicketStatus_UnknownAndMalformedIdentifiers404(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	for name, id := range map[string]string{
		"unknown":   "00000000-0000-0000-0000-000000000000",
		"malformed": "not-a-uuid",
	} {
		t.Run(name, func(t *testing.T) {
			resp := changeStatus(t, client, baseURL, id, Ready)
			if resp.status != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", resp.status)
			}
			if resp.errBody.Error.Code != "not_found" {
				t.Errorf("Error.Code = %q, want %q", resp.errBody.Error.Code, "not_found")
			}
		})
	}
}

// advanceToInReview drives a freshly captured (Backlog) Ticket through
// D3 S2's legitimate manual chain to In Review using three real HTTP
// calls -- Backlog -> Ready -> InProgress -> InReview -- exactly the
// sequence an Owner doing their own work would follow.
func advanceToInReview(t *testing.T, client *http.Client, baseURL, id string) {
	t.Helper()
	for _, to := range []TicketStatus{Ready, InProgress, InReview} {
		resp := changeStatus(t, client, baseURL, id, to)
		if resp.status != http.StatusOK {
			t.Fatalf("failed to advance ticket to %s: status=%d error=%+v", to, resp.status, resp.errBody)
		}
	}
}

func TestAcceptTicket_HumanAcceptanceCompletesFromInReview(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicketWithTemplate(t, client, baseURL, uniqueTitle(t), Basic)
	if created.CompletionCondition != HumanAcceptance {
		t.Fatalf("test setup error: CompletionCondition = %q, want %q", created.CompletionCondition, HumanAcceptance)
	}
	advanceToInReview(t, client, baseURL, created.Id)

	resp := acceptTicketHTTP(t, client, baseURL, created.Id)

	if resp.status != http.StatusOK {
		t.Fatalf("status = %d, want 200; error=%+v", resp.status, resp.errBody)
	}
	if resp.ticket.Status != Done {
		t.Errorf("Status = %q, want %q", resp.ticket.Status, Done)
	}
	persisted := getTicketHTTP(t, client, baseURL, created.Id)
	if persisted.Status != Done {
		t.Errorf("persisted Status = %q, want %q", persisted.Status, Done)
	}
}

// TestAcceptTicket_ReviewedPrMergeRejected is D3's central M2
// limitation: a reviewedPrMerge Ticket cannot complete in M2 at all.
// The rejection must name the current-implementation reason (D2/M8),
// and completionCondition must never be silently downgraded to
// humanAcceptance -- proven by re-fetching the ticket afterward.
func TestAcceptTicket_ReviewedPrMergeRejected(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicketWithTemplate(t, client, baseURL, uniqueTitle(t), Coding)
	if created.CompletionCondition != ReviewedPrMerge {
		t.Fatalf("test setup error: CompletionCondition = %q, want %q", created.CompletionCondition, ReviewedPrMerge)
	}
	advanceToInReview(t, client, baseURL, created.Id)

	resp := acceptTicketHTTP(t, client, baseURL, created.Id)

	if resp.status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; ticket=%+v", resp.status, resp.ticket)
	}
	if resp.errBody.Error.Code != reviewedPrMergeNotImplementedCode {
		t.Errorf("Error.Code = %q, want %q", resp.errBody.Error.Code, reviewedPrMergeNotImplementedCode)
	}
	if !containsAll(resp.errBody.Error.Message, "D2", "M8") {
		t.Errorf("Error.Message = %q, want it to name D2 and M8", resp.errBody.Error.Message)
	}

	persisted := getTicketHTTP(t, client, baseURL, created.Id)
	if persisted.Status != InReview {
		t.Errorf("persisted Status = %q, want unchanged %q (rejected Accept must not apply)", persisted.Status, InReview)
	}
	if persisted.CompletionCondition != ReviewedPrMerge {
		t.Errorf("persisted CompletionCondition = %q, want unchanged %q -- never silently downgrade to humanAcceptance",
			persisted.CompletionCondition, ReviewedPrMerge)
	}
}

func containsAll(s string, substrings ...string) bool {
	for _, sub := range substrings {
		if !bytes.Contains([]byte(s), []byte(sub)) {
			return false
		}
	}
	return true
}

// TestAcceptTicket_RejectsWhenNotInReview proves Accept is gated on
// current Status first, independently of completion condition: every
// non-InReview state is invalid_transition, never the D2/M8 message,
// regardless of which completion condition the ticket carries.
func TestAcceptTicket_RejectsWhenNotInReview(t *testing.T) {
	baseURL, client, pool, ownerID := devServerWithSessionAndPoolForTickets(t)

	for _, from := range []TicketStatus{Backlog, Ready, InProgress, Blocked, Done} {
		from := from
		t.Run(string(from), func(t *testing.T) {
			created := createTicket(t, client, baseURL, uniqueTitle(t))
			setTicketStatusDirect(t, pool, ownerID, created.Id, from)

			resp := acceptTicketHTTP(t, client, baseURL, created.Id)

			if resp.status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", resp.status)
			}
			if resp.errBody.Error.Code != invalidTransitionCode {
				t.Errorf("Error.Code = %q, want %q", resp.errBody.Error.Code, invalidTransitionCode)
			}
			persisted := getTicketHTTP(t, client, baseURL, created.Id)
			if persisted.Status != from {
				t.Errorf("persisted Status = %q, want unchanged %q", persisted.Status, from)
			}
		})
	}
}

func TestAcceptTicket_UnknownAndMalformedIdentifiers404(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	for name, id := range map[string]string{
		"unknown":   "00000000-0000-0000-0000-000000000000",
		"malformed": "not-a-uuid",
	} {
		t.Run(name, func(t *testing.T) {
			resp := acceptTicketHTTP(t, client, baseURL, id)
			if resp.status != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", resp.status)
			}
		})
	}
}

// TestAssignTicketOwner_SetsAssigneeTypeAndIsIdempotent covers assign,
// re-assign (idempotent), unassign, and re-unassign (idempotent) -- the
// full command surface for the only assignable Assignee in M2.
func TestAssignTicketOwner_SetsAssigneeTypeAndIsIdempotent(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))
	if created.AssigneeType != "" {
		t.Fatalf("test setup error: AssigneeType = %q, want unassigned", created.AssigneeType)
	}

	for i := 0; i < 2; i++ {
		resp := assignOwnerHTTP(t, client, baseURL, created.Id)
		if resp.status != http.StatusOK {
			t.Fatalf("assign #%d: status = %d, want 200; error=%+v", i, resp.status, resp.errBody)
		}
		if resp.ticket.AssigneeType != TicketAssigneeTypeOwner {
			t.Errorf("assign #%d: AssigneeType = %q, want %q", i, resp.ticket.AssigneeType, TicketAssigneeTypeOwner)
		}
	}

	for i := 0; i < 2; i++ {
		resp := unassignHTTP(t, client, baseURL, created.Id)
		if resp.status != http.StatusOK {
			t.Fatalf("unassign #%d: status = %d, want 200; error=%+v", i, resp.status, resp.errBody)
		}
		if resp.ticket.AssigneeType != "" {
			t.Errorf("unassign #%d: AssigneeType = %q, want unassigned", i, resp.ticket.AssigneeType)
		}
	}

	persisted := getTicketHTTP(t, client, baseURL, created.Id)
	if persisted.AssigneeType != "" {
		t.Errorf("persisted AssigneeType = %q, want unassigned", persisted.AssigneeType)
	}
}

// TestAssignTicketOwner_AllowedRegardlessOfStatus proves D3 places no
// Status precondition on human assignment (M2 never has an open Round
// to lock the Assignee field), and that assigning never itself changes
// Status.
func TestAssignTicketOwner_AllowedRegardlessOfStatus(t *testing.T) {
	baseURL, client, pool, ownerID := devServerWithSessionAndPoolForTickets(t)

	for _, status := range allTicketStatuses {
		status := status
		t.Run(string(status), func(t *testing.T) {
			created := createTicket(t, client, baseURL, uniqueTitle(t))
			setTicketStatusDirect(t, pool, ownerID, created.Id, status)

			resp := assignOwnerHTTP(t, client, baseURL, created.Id)

			if resp.status != http.StatusOK {
				t.Fatalf("status = %d, want 200; error=%+v", resp.status, resp.errBody)
			}
			if resp.ticket.AssigneeType != TicketAssigneeTypeOwner {
				t.Errorf("AssigneeType = %q, want %q", resp.ticket.AssigneeType, TicketAssigneeTypeOwner)
			}
			if resp.ticket.Status != status {
				t.Errorf("Status = %q, want unchanged %q -- assignment must never itself change Status", resp.ticket.Status, status)
			}
		})
	}
}

func TestAssignTicketOwner_UnknownAndMalformedIdentifiers404(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	for name, id := range map[string]string{
		"unknown":   "00000000-0000-0000-0000-000000000000",
		"malformed": "not-a-uuid",
	} {
		t.Run(name, func(t *testing.T) {
			if resp := assignOwnerHTTP(t, client, baseURL, id); resp.status != http.StatusNotFound {
				t.Fatalf("assign: status = %d, want 404", resp.status)
			}
			if resp := unassignHTTP(t, client, baseURL, id); resp.status != http.StatusNotFound {
				t.Fatalf("unassign: status = %d, want 404", resp.status)
			}
		})
	}
}

// TestApplyTicketTransition_ScopedToOwner and
// TestSetTicketAssigneeForOwner_ScopedToOwner follow
// TestUpdateTicket_ScopedToOwner's established technique
// (ticket_test.go): owners is a true one-row-per-deployment singleton,
// so a bogus owner id that can never belong to any real Owner is used
// instead of constructing a second real Owner row.
func TestApplyTicketTransition_ScopedToOwner(t *testing.T) {
	pool := postgres.NewTestPool(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, pool)
	_, publicID := insertTicketAt(t, pool, ownerID, uniqueTitle(t), time.Now().UTC())
	bogusOwnerID := ownerID + 1_000_000_000

	_, found, _, err := applyTicketTransition(ctx, pool, bogusOwnerID, publicID,
		func(current TicketStatus, _ TicketCompletionCondition) (TicketStatus, *transitionRejection) {
			return Ready, nil
		},
	)
	if err != nil {
		t.Fatalf("applyTicketTransition() returned unexpected error: %v", err)
	}
	if found {
		t.Error("found = true for a ticket belonging to a different owner, want false")
	}
}

func TestSetTicketAssigneeForOwner_ScopedToOwner(t *testing.T) {
	pool := postgres.NewTestPool(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, pool)
	_, publicID := insertTicketAt(t, pool, ownerID, uniqueTitle(t), time.Now().UTC())
	bogusOwnerID := ownerID + 1_000_000_000

	assigneeType := assigneeTypeOwnerValue
	_, found, err := setTicketAssigneeForOwner(ctx, pool, bogusOwnerID, publicID, &assigneeType)
	if err != nil {
		t.Fatalf("setTicketAssigneeForOwner() returned unexpected error: %v", err)
	}
	if found {
		t.Error("found = true for a ticket belonging to a different owner, want false")
	}
}

// TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies
// is the required concurrency acceptance criterion, against real
// PostgreSQL: two genuinely concurrent HTTP requests attempt two
// different, individually-valid transitions from the SAME persisted
// current Status (InProgress -> Blocked and InProgress -> InReview,
// both allowed from InProgress). applyTicketTransition's SELECT ... FOR
// UPDATE holds a row lock for its whole transaction, so whichever
// request's transaction commits first is the only one that can
// observe InProgress as the current status; the other's transaction
// necessarily starts its own SELECT only after the first commits (the
// lock blocks it), sees the now-different persisted Status, and is
// rejected. Exactly one request must succeed; the other must fail with
// invalidTransitionCode; and the final persisted Status must equal
// whichever one won -- never a corrupted or unresolved state, and
// never both succeeding (see docs/evidence/m2/60-lifecycle-transitions.md
// for a captured red run of this exact test against a deliberately
// un-locked, read-then-write implementation).
func TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	const trials = 15
	for trial := 0; trial < trials; trial++ {
		created := createTicket(t, client, baseURL, uniqueTitle(t))
		if resp := changeStatus(t, client, baseURL, created.Id, Ready); resp.status != http.StatusOK {
			t.Fatalf("trial %d: failed to advance to Ready: %+v", trial, resp.errBody)
		}
		if resp := changeStatus(t, client, baseURL, created.Id, InProgress); resp.status != http.StatusOK {
			t.Fatalf("trial %d: failed to advance to InProgress: %+v", trial, resp.errBody)
		}

		var wg sync.WaitGroup
		results := make([]lifecycleResult, 2)
		targets := []TicketStatus{Blocked, InReview}
		for i, target := range targets {
			wg.Add(1)
			go func(i int, target TicketStatus) {
				defer wg.Done()
				// net/http.Client is documented safe for concurrent
				// use, and both requests need only the one session
				// already established above -- sharing it here (rather
				// than signing in twice more against the fake OAuth
				// fixture, which is not designed for concurrent flows)
				// keeps the only thing these two requests actually
				// contend on the ticket row itself.
				results[i] = changeStatus(t, client, baseURL, created.Id, target)
			}(i, target)
		}
		wg.Wait()

		successes := 0
		var winner TicketStatus
		for i, resp := range results {
			switch resp.status {
			case http.StatusOK:
				successes++
				winner = targets[i]
				if resp.ticket.Status != targets[i] {
					t.Errorf("trial %d: winning response Status = %q, want %q", trial, resp.ticket.Status, targets[i])
				}
			case http.StatusBadRequest:
				if resp.errBody.Error.Code != invalidTransitionCode {
					t.Errorf("trial %d: losing Error.Code = %q, want %q", trial, resp.errBody.Error.Code, invalidTransitionCode)
				}
			default:
				t.Fatalf("trial %d: unexpected status %d (body=%+v)", trial, resp.status, resp)
			}
		}
		if successes != 1 {
			t.Fatalf("trial %d: %d of 2 concurrent conflicting transitions succeeded, want exactly 1 (results=%+v)", trial, successes, results)
		}

		persisted := getTicketHTTP(t, client, baseURL, created.Id)
		if persisted.Status != winner {
			t.Fatalf("trial %d: persisted Status = %q, want the winning transition's target %q", trial, persisted.Status, winner)
		}
	}
}
