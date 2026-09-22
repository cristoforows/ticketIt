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
	"unicode/utf8"

	"github.com/google/uuid"
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
	if created.Id == "" {
		t.Error("Id is empty, want an assigned public identifier")
	}
	if _, err := uuid.Parse(created.Id); err != nil {
		t.Errorf("Id = %q is not a valid UUID: %v", created.Id, err)
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

func TestCreateTicket_CountsTitleLengthInCharactersNotBytes(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	// contracts/openapi.yaml's maxLength is a JSON Schema constraint,
	// so it counts code points. A byte-based check would reject this
	// contract-valid title, and every other title test is ASCII, where
	// the two counts coincide and the difference stays invisible.
	suffix := uniqueTitle(t)
	title := suffix + strings.Repeat("\u65e5", ticketTitleMaxLength-utf8.RuneCountInString(suffix))
	if got := utf8.RuneCountInString(title); got != ticketTitleMaxLength {
		t.Fatalf("test setup error: constructed title has %d characters, want %d", got, ticketTitleMaxLength)
	}
	if len(title) <= ticketTitleMaxLength {
		t.Fatalf("test setup error: constructed title has %d bytes, which does not exercise the distinction", len(title))
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
		t.Fatalf("expected both tickets (older id=%s, newer id=%s) in the list of %d tickets", older.Id, newer.Id, len(tickets))
	}
	if newerIdx >= olderIdx {
		t.Errorf("newer ticket (id=%s) at index %d did not come before older ticket (id=%s) at index %d -- want newest first",
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
	firstID, firstPublicID := insertTicketAt(t, pool, ownerID, uniqueTitle(t)+"-tied-first", tiedAt)
	secondID, secondPublicID := insertTicketAt(t, pool, ownerID, uniqueTitle(t)+"-tied-second", tiedAt)

	tickets, err := listTicketsForOwner(ctx, pool, ownerID)
	if err != nil {
		t.Fatalf("listTicketsForOwner() returned unexpected error: %v", err)
	}

	firstIdx, secondIdx := -1, -1
	for i, ticket := range tickets {
		if ticket.Id == firstPublicID {
			firstIdx = i
		}
		if ticket.Id == secondPublicID {
			secondIdx = i
		}
	}
	if firstIdx == -1 || secondIdx == -1 {
		t.Fatalf("expected both tied tickets (public ids %s, %s) in the list of %d tickets", firstPublicID, secondPublicID, len(tickets))
	}
	// secondID > firstID (IDENTITY is monotonic, internal id -- never
	// exposed by the API, but the only way to know insertion order
	// here), so with equal created_at the documented "id DESC" tiebreak
	// must place it first. public_id is random and carries no order of
	// its own, which is why this test still needs the internal id.
	if secondID <= firstID {
		t.Fatalf("test setup error: secondID (%d) is not greater than firstID (%d)", secondID, firstID)
	}
	if secondIdx >= firstIdx {
		t.Errorf("with tied created_at, the ticket inserted second (public id %s) at index %d did not come before the one inserted first (public id %s) at index %d -- want id DESC to break the tie",
			secondPublicID, secondIdx, firstPublicID, firstIdx)
	}
}

// insertTicketAt inserts a row directly with an explicit created_at
// (bypassing insertTicket, which always uses now()) -- the only way to
// construct the exact-tie fixture the test above needs. It generates
// its own public_id (mirroring insertTicket) and returns both that and
// the internal id -- the latter only to let a test reason about
// insertion order (IDENTITY is monotonic); no API response ever
// exposes it.
func insertTicketAt(t *testing.T, pool *pgxpool.Pool, ownerID int64, title string, at time.Time) (id int64, publicID string) {
	t.Helper()
	publicID = uuid.NewString()
	err := pool.QueryRow(context.Background(),
		`INSERT INTO tickets (owner_id, title, status, public_id, created_at, updated_at) VALUES ($1, $2, $3, $4::uuid, $5, $5) RETURNING id`,
		ownerID, title, string(Backlog), publicID, at,
	).Scan(&id)
	if err != nil {
		t.Fatalf("failed to insert fixture ticket: %v", err)
	}
	return id, publicID
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

func getTicket(t *testing.T, client *http.Client, baseURL, id string) (*http.Response, []byte) {
	t.Helper()
	resp, err := client.Get(baseURL + "/api/tickets/" + id)
	if err != nil {
		t.Fatalf("GET /api/tickets/%s failed: %v", id, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

// TestGetTicket_ReturnsOwnersTicket proves the round trip end to end:
// a created Ticket's own public id fetches back exactly that Ticket.
func TestGetTicket_ReturnsOwnersTicket(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	title := uniqueTitle(t)
	created := createTicket(t, client, baseURL, title)

	resp, data := getTicket(t, client, baseURL, created.Id)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, data)
	}
	var got Ticket
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("failed to decode response %q: %v", data, err)
	}
	if got != created {
		t.Errorf("GetTicket(%s) = %+v, want %+v", created.Id, got, created)
	}
}

// TestGetTicket_RequiresSession is this endpoint's own direct-API proof
// (ADR 0001) that authentication is Galley's rule, not the UI's.
func TestGetTicket_RequiresSession(t *testing.T) {
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/tickets/"+uuid.NewString(), nil)
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

// TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable is
// issue #57's central privacy requirement, proven byte-for-byte: a
// well-formed but nonexistent identifier and a malformed one (not a
// UUID at all) must produce the exact same 404 response, so neither
// ever reveals which case occurred -- the same technique
// production_gating_test.go uses to prove two responses are identical,
// not merely similar.
func TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	unknownResp, unknownBody := getTicket(t, client, baseURL, uuid.NewString())
	malformedResp, malformedBody := getTicket(t, client, baseURL, "not-a-uuid-at-all")

	if unknownResp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown identifier: status = %d, want %d; body=%s", unknownResp.StatusCode, http.StatusNotFound, unknownBody)
	}
	if malformedResp.StatusCode != http.StatusNotFound {
		t.Fatalf("malformed identifier: status = %d, want %d; body=%s", malformedResp.StatusCode, http.StatusNotFound, malformedBody)
	}
	if string(unknownBody) != string(malformedBody) {
		t.Errorf("unknown identifier body %s differs from malformed identifier body %s -- both must be indistinguishable", unknownBody, malformedBody)
	}
}

// TestGetTicket_ScopedToOwner is TestListTicketsForOwner_ScopedToOwner's
// counterpart for GetTicket, and follows the same technique for the
// same reason: owners is a true one-row-per-deployment singleton, so a
// second real Owner cannot be constructed to prove "another Owner's
// Ticket returns 404" directly. Querying getTicketForOwner with a
// bogus owner id that can never belong to any real Owner proves the
// same scoping mechanism both listTicketsForOwner and getTicketForOwner
// share: a Ticket's public_id lookup is always filtered by owner_id, so
// it is unreachable for any owner id other than the one it actually
// belongs to -- exactly what "another Owner's identifier returns the
// same 404" requires, without ever creating a second Owner row.
func TestGetTicket_ScopedToOwner(t *testing.T) {
	pool := postgres.NewTestPool(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, pool)
	_, publicID := insertTicketAt(t, pool, ownerID, uniqueTitle(t), time.Now().UTC())

	bogusOwnerID := ownerID + 1_000_000_000

	_, found, err := getTicketForOwner(ctx, pool, bogusOwnerID, publicID)
	if err != nil {
		t.Fatalf("getTicketForOwner() returned unexpected error: %v", err)
	}
	if found {
		t.Errorf("getTicketForOwner(bogusOwnerID, %s) found a ticket belonging to a different owner -- owner scoping is not enforced", publicID)
	}
}

func TestGetTicket_MethodNotAllowed(t *testing.T) {
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/tickets/"+uuid.NewString(), nil)
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

// strPtr is UpdateTicketRequest's pointer fields' constructor: a nil
// *string means "absent from the request body" (contracts/openapi.yaml's
// documented partial-update rule), so every test below that wants a
// field genuinely present -- even as "" -- must take its address
// explicitly rather than leave the struct literal's field unset.
func strPtr(s string) *string { return &s }

func patchTicket(t *testing.T, client *http.Client, baseURL, id string, body UpdateTicketRequest) (*http.Response, []byte) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}
	req, err := http.NewRequest(http.MethodPatch, baseURL+"/api/tickets/"+id, bytes.NewReader(data))
	if err != nil {
		t.Fatalf("failed to build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("PATCH /api/tickets/%s failed: %v", id, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return resp, respBody
}

// TestUpdateTicket_OnlyProvidedFieldsChange is issue #58's central
// correctness requirement, proven the way the issue itself demands:
// PATCH names only "title," and every other already-set refinement
// field must come back exactly as it was -- not reset to "" (which a
// bare, non-pointer Go string would silently do if title and the four
// refinement fields shared one "was this present" signal instead of
// each having its own nil/non-nil pointer).
func TestUpdateTicket_OnlyProvidedFieldsChange(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{
		Goal:            strPtr("Ship the feature"),
		Context:         strPtr("See the linked issue"),
		SuccessCriteria: strPtr("Tests pass"),
		Constraints:     strPtr("Do not change the API"),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initial refinement PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}

	newTitle := uniqueTitle(t) + "-retitled"
	resp, body = patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Title: strPtr(newTitle)})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("title-only PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}

	if updated.Title != newTitle {
		t.Errorf("Title = %q, want %q", updated.Title, newTitle)
	}
	if updated.Goal != "Ship the feature" {
		t.Errorf("Goal = %q, want unchanged %q -- a title-only PATCH must not touch it", updated.Goal, "Ship the feature")
	}
	if updated.Context != "See the linked issue" {
		t.Errorf("Context = %q, want unchanged %q -- a title-only PATCH must not touch it", updated.Context, "See the linked issue")
	}
	if updated.SuccessCriteria != "Tests pass" {
		t.Errorf("SuccessCriteria = %q, want unchanged %q -- a title-only PATCH must not touch it", updated.SuccessCriteria, "Tests pass")
	}
	if updated.Constraints != "Do not change the API" {
		t.Errorf("Constraints = %q, want unchanged %q -- a title-only PATCH must not touch it", updated.Constraints, "Do not change the API")
	}
}

// TestUpdateTicket_EmptyStringClearsField is the partial-update
// contract's second documented case: a field present and set to ""
// clears the stored value, distinct from leaving it absent.
func TestUpdateTicket_EmptyStringClearsField(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Goal: strPtr("Ship the feature")})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}

	resp, body = patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Goal: strPtr("")})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clearing PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	if updated.Goal != "" {
		t.Errorf("Goal = %q, want \"\" (cleared)", updated.Goal)
	}
}

// TestUpdateTicket_AbsentFieldLeavesValueUnchanged is the partial-update
// contract's first documented case, exercised directly (a title-only
// PATCH already proves it for the four refinement fields together --
// see TestUpdateTicket_OnlyProvidedFieldsChange -- this covers a
// refinement-only PATCH leaving the title itself untouched).
func TestUpdateTicket_AbsentFieldLeavesValueUnchanged(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	title := uniqueTitle(t)
	created := createTicket(t, client, baseURL, title)

	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Constraints: strPtr("Keep it backwards compatible")})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	if updated.Title != title {
		t.Errorf("Title = %q, want unchanged %q -- title was absent from the request", updated.Title, title)
	}
}

// TestUpdateTicket_TrimsRefinementFields mirrors
// TestCreateTicket_TrimsTitle for every field this endpoint accepts.
func TestUpdateTicket_TrimsRefinementFields(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{
		Goal:            strPtr("  Ship the feature  \t"),
		Context:         strPtr("\nSee the linked issue\n"),
		SuccessCriteria: strPtr("  Tests pass"),
		Constraints:     strPtr("Do not change the API   "),
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	if updated.Goal != "Ship the feature" {
		t.Errorf("Goal = %q, want trimmed %q", updated.Goal, "Ship the feature")
	}
	if updated.Context != "See the linked issue" {
		t.Errorf("Context = %q, want trimmed %q", updated.Context, "See the linked issue")
	}
	if updated.SuccessCriteria != "Tests pass" {
		t.Errorf("SuccessCriteria = %q, want trimmed %q", updated.SuccessCriteria, "Tests pass")
	}
	if updated.Constraints != "Do not change the API" {
		t.Errorf("Constraints = %q, want trimmed %q", updated.Constraints, "Do not change the API")
	}
}

// TestUpdateTicket_WhitespaceOnlyRefinementFieldClears documents the
// deliberate conflation this endpoint makes for the four refinement
// fields only (never title): a value that trims to "" is treated
// exactly like an explicit "", i.e. it clears the field rather than
// being rejected.
func TestUpdateTicket_WhitespaceOnlyRefinementFieldClears(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))
	if resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Goal: strPtr("Ship it")}); resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}

	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Goal: strPtr("   \t\n  ")})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	if updated.Goal != "" {
		t.Errorf("Goal = %q, want \"\" (whitespace-only clears, same as an explicit \"\")", updated.Goal)
	}
}

// TestUpdateTicket_RejectsClearingTitle proves title's documented
// exception to the shared absent/empty/text rule: clearing it is
// rejected, not applied, and the stored title is left untouched.
func TestUpdateTicket_RejectsClearingTitle(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	title := uniqueTitle(t)
	created := createTicket(t, client, baseURL, title)

	cases := []string{"", "   ", "\t\n "}
	for _, value := range cases {
		t.Run(strings.TrimSpace("blank_"+value), func(t *testing.T) {
			resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Title: strPtr(value)})
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
	if got.Title != title {
		t.Errorf("Title = %q after a rejected clear, want unchanged %q", got.Title, title)
	}
}

func getTicketAssertOK(t *testing.T, client *http.Client, baseURL, id string) Ticket {
	t.Helper()
	resp, body := getTicket(t, client, baseURL, id)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var ticket Ticket
	if err := json.Unmarshal(body, &ticket); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	return ticket
}

// TestUpdateTicket_RejectsOverLengthFields covers every field's own
// documented maximum, mirroring
// TestCreateTicket_RejectsTitleOverMaxLength.
func TestUpdateTicket_RejectsOverLengthFields(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	cases := []struct {
		name    string
		request UpdateTicketRequest
	}{
		{"title", UpdateTicketRequest{Title: strPtr(strings.Repeat("x", ticketTitleMaxLength+1))}},
		{"goal", UpdateTicketRequest{Goal: strPtr(strings.Repeat("x", ticketGoalMaxLength+1))}},
		{"context", UpdateTicketRequest{Context: strPtr(strings.Repeat("x", ticketContextMaxLength+1))}},
		{"successCriteria", UpdateTicketRequest{SuccessCriteria: strPtr(strings.Repeat("x", ticketSuccessCriteriaMaxLength+1))}},
		{"constraints", UpdateTicketRequest{Constraints: strPtr(strings.Repeat("x", ticketConstraintsMaxLength+1))}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, body := patchTicket(t, client, baseURL, created.Id, tc.request)
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
}

// TestUpdateTicket_AcceptsFieldsAtMaxLength mirrors
// TestCreateTicket_AcceptsTitleAtMaxLength for the four refinement
// fields, proving the boundary itself is accepted.
func TestUpdateTicket_AcceptsFieldsAtMaxLength(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	goal := strings.Repeat("g", ticketGoalMaxLength)
	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Goal: strPtr(goal)})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	if updated.Goal != goal {
		t.Errorf("Goal length = %d, want %d characters accepted unchanged", len(updated.Goal), ticketGoalMaxLength)
	}
}

// TestUpdateTicket_CountsFieldLengthInCharactersNotBytes is issue #58's
// own required non-ASCII test, mirroring
// TestCreateTicket_CountsTitleLengthInCharactersNotBytes exactly: a
// byte-based check would reject this contract-valid title at roughly a
// third of the documented limit.
func TestUpdateTicket_CountsFieldLengthInCharactersNotBytes(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	goal := strings.Repeat("日", ticketGoalMaxLength)
	if got := utf8.RuneCountInString(goal); got != ticketGoalMaxLength {
		t.Fatalf("test setup error: constructed goal has %d characters, want %d", got, ticketGoalMaxLength)
	}
	if len(goal) <= ticketGoalMaxLength {
		t.Fatalf("test setup error: constructed goal has %d bytes, which does not exercise the distinction", len(goal))
	}

	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{Goal: strPtr(goal)})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}
	if updated.Goal != goal {
		t.Errorf("Goal = %q, want %q", updated.Goal, goal)
	}
}

func TestUpdateTicket_RejectsMalformedJSON(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	req, err := http.NewRequest(http.MethodPatch, baseURL+"/api/tickets/"+created.Id, strings.NewReader(`not json`))
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

// TestUpdateTicket_RequiresSession is this endpoint's own direct-API
// proof (ADR 0001) that authentication is Galley's rule, not the UI's.
func TestUpdateTicket_RequiresSession(t *testing.T) {
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodPatch, "/api/tickets/"+uuid.NewString(), strings.NewReader(`{"title":"x"}`))
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

// TestUpdateTicket_UnknownAndMalformedIdentifiersAreIndistinguishable
// is TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable's
// counterpart for this endpoint, proven the same byte-for-byte way.
func TestUpdateTicket_UnknownAndMalformedIdentifiersAreIndistinguishable(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)

	unknownResp, unknownBody := patchTicket(t, client, baseURL, uuid.NewString(), UpdateTicketRequest{Title: strPtr(uniqueTitle(t))})
	malformedResp, malformedBody := patchTicket(t, client, baseURL, "not-a-uuid-at-all", UpdateTicketRequest{Title: strPtr(uniqueTitle(t))})

	if unknownResp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown identifier: status = %d, want %d; body=%s", unknownResp.StatusCode, http.StatusNotFound, unknownBody)
	}
	if malformedResp.StatusCode != http.StatusNotFound {
		t.Fatalf("malformed identifier: status = %d, want %d; body=%s", malformedResp.StatusCode, http.StatusNotFound, malformedBody)
	}
	if string(unknownBody) != string(malformedBody) {
		t.Errorf("unknown identifier body %s differs from malformed identifier body %s -- both must be indistinguishable", unknownBody, malformedBody)
	}
}

// TestUpdateTicket_ScopedToOwner is TestGetTicket_ScopedToOwner's
// counterpart for updateTicketForOwner, following the same technique
// for the same reason (owners is a true one-row-per-deployment
// singleton -- see that test's own comment): a bogus owner id must not
// be able to update a Ticket it does not own.
func TestUpdateTicket_ScopedToOwner(t *testing.T) {
	pool := postgres.NewTestPool(t)
	ctx := context.Background()
	ownerID := resolveTestOwner(t, pool)
	title := uniqueTitle(t)
	_, publicID := insertTicketAt(t, pool, ownerID, title, time.Now().UTC())

	bogusOwnerID := ownerID + 1_000_000_000

	_, found, err := updateTicketForOwner(ctx, pool, bogusOwnerID, publicID, ticketUpdate{title: strPtr(uniqueTitle(t) + "-hijacked")})
	if err != nil {
		t.Fatalf("updateTicketForOwner() returned unexpected error: %v", err)
	}
	if found {
		t.Errorf("updateTicketForOwner(bogusOwnerID, %s) updated a ticket belonging to a different owner -- owner scoping is not enforced", publicID)
	}

	ticket, found, err := getTicketForOwner(ctx, pool, ownerID, publicID)
	if err != nil {
		t.Fatalf("getTicketForOwner() returned unexpected error: %v", err)
	}
	if !found {
		t.Fatalf("expected the ticket to still exist under its real owner")
	}
	if ticket.Title != title {
		t.Errorf("Title = %q after a rejected cross-owner update attempt, want unchanged %q", ticket.Title, title)
	}
}

// TestUpdateTicket_BumpsUpdatedAtButNotCreatedAt proves the
// concurrent-edit rule's own side effect: every PATCH is a write, so
// updatedAt always advances, even for a PATCH whose body names no
// field at all (apps/galley/README.md, "Manual refinement fields").
// createdAt never changes -- a Ticket's capture time is immutable.
func TestUpdateTicket_BumpsUpdatedAtButNotCreatedAt(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	created := createTicket(t, client, baseURL, uniqueTitle(t))

	// createdAt/updatedAt are formatted at second precision (RFC3339, no
	// fractional seconds -- see insertTicket/scanTicketRow), so the
	// sleep must clear a whole second boundary, not just be "nonzero,"
	// to observably advance the formatted string.
	time.Sleep(1100 * time.Millisecond)

	resp, body := patchTicket(t, client, baseURL, created.Id, UpdateTicketRequest{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("empty-body PATCH status = %d, want %d; body=%s", resp.StatusCode, http.StatusOK, body)
	}
	var updated Ticket
	if err := json.Unmarshal(body, &updated); err != nil {
		t.Fatalf("failed to decode response %q: %v", body, err)
	}

	if updated.CreatedAt != created.CreatedAt {
		t.Errorf("CreatedAt = %q, want unchanged %q", updated.CreatedAt, created.CreatedAt)
	}
	if updated.UpdatedAt == created.UpdatedAt {
		t.Errorf("UpdatedAt = %q, want it to advance past %q after a PATCH", updated.UpdatedAt, created.UpdatedAt)
	}
	if updated.Title != created.Title {
		t.Errorf("Title = %q, want unchanged %q -- the PATCH body named no field", updated.Title, created.Title)
	}
}

func TestUpdateTicket_MethodAllowedOnTicketPath(t *testing.T) {
	// PATCH joining GET on /api/tickets/{id} is exercised implicitly by
	// every test above; this only proves the *other* methods still
	// reject cleanly with the updated Allow set.
	handler := devHandler(t)

	req := httptest.NewRequest(http.MethodDelete, "/api/tickets/"+uuid.NewString(), nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusMethodNotAllowed, rec.Body.String())
	}
	allow := rec.Header().Get("Allow")
	if allow != "GET, PATCH" {
		t.Errorf("Allow header = %q, want %q", allow, "GET, PATCH")
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

	t.Run("get", func(t *testing.T) {
		req := withCookie(httptest.NewRequest(http.MethodGet, "/api/tickets/"+uuid.NewString(), nil))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
		}
	})

	t.Run("update", func(t *testing.T) {
		req := withCookie(httptest.NewRequest(http.MethodPatch, "/api/tickets/"+uuid.NewString(), strings.NewReader(`{"title":"x"}`)))
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
