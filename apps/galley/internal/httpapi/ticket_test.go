package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/authtest"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/githubfake"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// uniqueTitle returns a title unlikely to collide with any other test's
// or developer's rows in the shared, real, persistent ticketit_test
// database -- matching diagnostic_test.go's uniqueNote convention, for
// the same reason: this suite never truncates tickets between runs.
func uniqueTitle(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("failed to generate a unique title: %v", err)
	}
	return "ticket_test-" + t.Name() + "-" + hex.EncodeToString(b[:])
}

func devServerWithSessionForTickets(t *testing.T) (baseURL string, client *http.Client) {
	t.Helper()
	pool := postgres.NewTestPool(t)
	fake := githubfake.New(t, githubfake.TestOwnerIdentity)
	srv, _ := startTestGalley(t, pool, config.EnvDevelopment, fake)
	client = authtest.NewClient()
	authtest.SignIn(t, client, srv.URL)
	return srv.URL, client
}

func createTicket(t *testing.T, client *http.Client, baseURL, title string) Ticket {
	t.Helper()
	body, err := json.Marshal(CreateTicketRequest{Title: title})
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/tickets", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST /api/tickets failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/tickets status = %d, want %d; body=%s", resp.StatusCode, http.StatusCreated, data)
	}
	var created Ticket
	if err := json.Unmarshal(data, &created); err != nil {
		t.Fatalf("failed to decode create response %q: %v", data, err)
	}
	return created
}

func listTickets(t *testing.T, client *http.Client, baseURL string) []Ticket {
	t.Helper()
	resp, err := client.Get(baseURL + "/api/tickets")
	if err != nil {
		t.Fatalf("GET /api/tickets failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/tickets status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, data)
	}
	var list TicketList
	if err := json.Unmarshal(data, &list); err != nil {
		t.Fatalf("failed to decode list response %q: %v", data, err)
	}
	return list.Tickets
}

func TestCreateTicket_TitleOnlyCapturesBacklog(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	title := uniqueTitle(t)

	created := createTicket(t, client, baseURL, title)

	if created.Title != title {
		t.Errorf("Title = %q, want %q", created.Title, title)
	}
	if created.Status != Backlog {
		t.Errorf("Status = %q, want %q", created.Status, Backlog)
	}
	if created.Id == 0 {
		t.Error("Id is zero, want an assigned id")
	}
	if created.CreatedAt == "" {
		t.Error("CreatedAt is empty")
	}
	if created.UpdatedAt == "" {
		t.Error("UpdatedAt is empty")
	}
}

func TestCreateTicket_TrimsTitle(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	title := uniqueTitle(t)

	created := createTicket(t, client, baseURL, "  "+title+"  \t")

	if created.Title != title {
		t.Errorf("Title = %q, want trimmed %q", created.Title, title)
	}
}

func TestCreateTicket_RejectsBlankTitle(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	cases := []string{"", "   ", "\t\n "}
	for _, title := range cases {
		t.Run(strings.TrimSpace("blank_"+title), func(t *testing.T) {
			body, err := json.Marshal(CreateTicketRequest{Title: title})
			if err != nil {
				t.Fatalf("failed to marshal request: %v", err)
			}
			req, err := http.NewRequest(http.MethodPost, baseURL+"/api/tickets", bytes.NewReader(body))
			if err != nil {
				t.Fatalf("failed to build request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer resp.Body.Close()
			data, _ := io.ReadAll(resp.Body)

			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusBadRequest, data)
			}
			var errBody ErrorBody
			if err := json.Unmarshal(data, &errBody); err != nil {
				t.Fatalf("failed to decode error body %q: %v", data, err)
			}
			if errBody.Error.Code != "invalid_request" {
				t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "invalid_request")
			}
		})
	}
}

func TestCreateTicket_RejectsTitleOverMaxLength(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	title := strings.Repeat("x", ticketTitleMaxLength+1)
	body, err := json.Marshal(CreateTicketRequest{Title: title})
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/tickets", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusBadRequest, data)
	}
	var errBody ErrorBody
	if err := json.Unmarshal(data, &errBody); err != nil {
		t.Fatalf("failed to decode error body %q: %v", data, err)
	}
	if errBody.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "invalid_request")
	}
}

func TestCreateTicket_AcceptsTitleAtMaxLength(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	// Unique per run (see uniqueTitle) but padded out to exactly the
	// documented maximum, proving the boundary itself is accepted, not
	// just values comfortably under it.
	suffix := uniqueTitle(t)
	title := suffix + strings.Repeat("x", ticketTitleMaxLength-len(suffix))
	if len(title) != ticketTitleMaxLength {
		t.Fatalf("test setup error: constructed title has length %d, want %d", len(title), ticketTitleMaxLength)
	}

	created := createTicket(t, client, baseURL, title)
	if created.Title != title {
		t.Errorf("Title = %q, want %q", created.Title, title)
	}
}

func TestCreateTicket_RejectsMalformedJSON(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/tickets", strings.NewReader(`not json`))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusBadRequest, data)
	}
	var errBody ErrorBody
	if err := json.Unmarshal(data, &errBody); err != nil {
		t.Fatalf("failed to decode error body %q: %v", data, err)
	}
	if errBody.Error.Code != "invalid_request" {
		t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "invalid_request")
	}
}

// TestCreateTicket_RequiresSession and TestListTickets_RequiresSession
// are this slice's direct-API proof (ADR 0001, issue #56's acceptance
// criterion 4) that ownership/validation is Galley's rule, not the
// UI's: a request with no session cookie at all, never reaching any
// browser code, is rejected before either query runs.
func TestCreateTicket_RequiresSession(t *testing.T) {
	handler := devHandler(t)

	body := strings.NewReader(`{"title":"unauthenticated attempt"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/tickets", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
	var errBody ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if errBody.Error.Code != "unauthenticated" {
		t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "unauthenticated")
	}
}

func TestListTickets_RequiresSession(t *testing.T) {
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/tickets", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
	var errBody ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if errBody.Error.Code != "unauthenticated" {
		t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "unauthenticated")
	}
}

// TestListTickets_NewestFirstWithIdTiebreak proves the documented
// order end to end through the real HTTP handler: a ticket created
// after another must appear before it. This does not by itself prove
// the id tiebreak (two sequential real requests essentially never
// share a created_at value) -- see
// TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies below for
// that specific edge case, exercised directly against the query.
func TestListTickets_NewestFirstWithIdTiebreak(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	older := createTicket(t, client, baseURL, uniqueTitle(t)+"-older")
	newer := createTicket(t, client, baseURL, uniqueTitle(t)+"-newer")

	tickets := listTickets(t, client, baseURL)

	olderIdx, newerIdx := -1, -1
	for i, ticket := range tickets {
		if ticket.Id == older.Id {
			olderIdx = i
		}
		if ticket.Id == newer.Id {
			newerIdx = i
		}
	}
	if olderIdx == -1 || newerIdx == -1 {
		t.Fatalf("expected both tickets (older id=%d, newer id=%d) in the list of %d tickets", older.Id, newer.Id, len(tickets))
	}
	if newerIdx >= olderIdx {
		t.Errorf("newer ticket (id=%d) at index %d did not come before older ticket (id=%d) at index %d -- want newest first",
			newer.Id, newerIdx, older.Id, olderIdx)
	}
}

// TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies exercises
// listTicketsForOwner directly (bypassing HTTP) against two rows
// inserted with an identical created_at, which two real, sequential
// POST /api/tickets requests essentially never produce -- this is the
// only way to actually force the tie the documented order promises to
// break deterministically.
func TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies(t *testing.T) {
	pool := postgres.NewTestPool(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, pool)

	tiedAt := time.Now().UTC()
	firstID := insertTicketAt(t, pool, ownerID, uniqueTitle(t)+"-tied-first", tiedAt)
	secondID := insertTicketAt(t, pool, ownerID, uniqueTitle(t)+"-tied-second", tiedAt)

	tickets, err := listTicketsForOwner(ctx, pool, ownerID)
	if err != nil {
		t.Fatalf("listTicketsForOwner() returned unexpected error: %v", err)
	}

	firstIdx, secondIdx := -1, -1
	for i, ticket := range tickets {
		if int64(ticket.Id) == firstID {
			firstIdx = i
		}
		if int64(ticket.Id) == secondID {
			secondIdx = i
		}
	}
	if firstIdx == -1 || secondIdx == -1 {
		t.Fatalf("expected both tied tickets (ids %d, %d) in the list of %d tickets", firstID, secondID, len(tickets))
	}
	// secondID > firstID (IDENTITY is monotonic), so with equal
	// created_at the documented "id DESC" tiebreak must place it first.
	if secondIdx >= firstIdx {
		t.Errorf("with tied created_at, higher id %d at index %d did not come before lower id %d at index %d -- want id DESC to break the tie",
			secondID, secondIdx, firstID, firstIdx)
	}
}

// insertTicketAt inserts a row directly with an explicit created_at
// (bypassing insertTicket, which always uses now()) -- the only way to
// construct the exact-tie fixture the test above needs.
func insertTicketAt(t *testing.T, pool *pgxpool.Pool, ownerID int64, title string, at time.Time) (id int64) {
	t.Helper()
	err := pool.QueryRow(context.Background(),
		`INSERT INTO tickets (owner_id, title, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
		ownerID, title, string(Backlog), at,
	).Scan(&id)
	if err != nil {
		t.Fatalf("failed to insert fixture ticket: %v", err)
	}
	return id
}

// resolveTestOwner bootstraps (or reuses) the one real Owner, the same
// way mintTestSessionCookie does, for a test that needs the owner id
// directly rather than a ready-to-attach cookie.
func resolveTestOwner(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	identity := githubfake.TestOwnerIdentity
	ownerID, _, err := auth.ResolveOwner(context.Background(), pool, identity.Login, auth.ProviderIdentity{ID: identity.ID, Login: identity.Login})
	if err != nil {
		t.Fatalf("failed to resolve the test owner: %v", err)
	}
	return ownerID
}

// TestListTicketsForOwner_ScopedToOwner is this slice's proof that
// listTicketsForOwner's "WHERE owner_id = $1" genuinely scopes
// results, not merely that scoping has never been observed to fail
// because only one Owner has ever existed in this test database.
//
// It deliberately does not construct a second real Owner to prove
// this: `owners` is a true one-row-per-deployment singleton
// (owners_singleton_uq), and another test in this same package
// (auth_test.go's TestOAuthSignIn_HappyPath) asserts `select count(*)
// from owners` is exactly 1 against this same shared, persistent
// ticketit_test database -- a second Owner row here, even one an
// ordinary sign-in could never produce, would make that assertion
// fail. Querying with an owner id that could never belong to any real
// Owner (ids are small, densely allocated sequential integers; this
// one is offset far out of that range) needs no such row to exist: if
// listTicketsForOwner ever regressed to an unscoped "select * from
// tickets", this bogus id would immediately start returning the real
// ticket created below instead of nothing.
func TestListTicketsForOwner_ScopedToOwner(t *testing.T) {
	pool := postgres.NewTestPool(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, pool)
	title := uniqueTitle(t)
	insertTicketAt(t, pool, ownerID, title, time.Now().UTC())

	bogusOwnerID := ownerID + 1_000_000_000

	tickets, err := listTicketsForOwner(ctx, pool, bogusOwnerID)
	if err != nil {
		t.Fatalf("listTicketsForOwner() returned unexpected error: %v", err)
	}
	for _, ticket := range tickets {
		if ticket.Title == title {
			t.Errorf("listTicketsForOwner(bogusOwnerID) returned a ticket belonging to a different owner (title=%q) -- owner scoping is not enforced", title)
		}
	}
}

func TestTickets_DatabaseUnavailable(t *testing.T) {
	pool := unreachablePool(t)
	cfg := config.Config{Environment: config.EnvDevelopment, Version: "dev"}
	handler := NewHandler(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}))

	withCookie := func(req *http.Request) *http.Request {
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "irrelevant-the-lookup-itself-fails"})
		return req
	}

	t.Run("list", func(t *testing.T) {
		req := withCookie(httptest.NewRequest(http.MethodGet, "/api/tickets", nil))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
		}
	})

	t.Run("create", func(t *testing.T) {
		req := withCookie(httptest.NewRequest(http.MethodPost, "/api/tickets", strings.NewReader(`{"title":"x"}`)))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
		}
	})
}

func TestTickets_MethodNotAllowed(t *testing.T) {
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/tickets", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusMethodNotAllowed, rec.Body.String())
	}
	var errBody ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("failed to decode error body %q: %v", rec.Body.String(), err)
	}
	if errBody.Error.Code != "method_not_allowed" {
		t.Errorf("Error.Code = %q, want %q", errBody.Error.Code, "method_not_allowed")
	}
}
