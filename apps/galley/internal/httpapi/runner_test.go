package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/auth"
	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
}

type runnerFixture struct {
	handler http.Handler
	pool    *pgxpool.Pool
	cookie  *http.Cookie
	clock   *fakeClock
}

var runnerEpoch = time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

func newRunnerFixture(t *testing.T) runnerFixture {
	t.Helper()
	return newRunnerFixtureWith(t, config.Config{Environment: config.EnvDevelopment, Version: "dev"})
}

func newRunnerFixtureWith(t *testing.T, cfg config.Config) runnerFixture {
	t.Helper()
	pool := postgres.NewEmptyMigratedTestPool(t)
	clock := &fakeClock{now: runnerEpoch}
	handler := NewHandlerWithClock(cfg, time.Now(), pool, testLogger(&bytes.Buffer{}), clock.Now)
	return runnerFixture{handler: handler, pool: pool, cookie: mintTestSessionCookie(t, pool), clock: clock}
}

type runnerCall struct {
	method, path, body string
	token              string
	cookie             *http.Cookie
}

func (f runnerFixture) do(t *testing.T, call runnerCall) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(call.method, call.path, strings.NewReader(call.body))
	if call.body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if call.token != "" {
		req.Header.Set("Authorization", "Bearer "+call.token)
	}
	if call.cookie != nil {
		req.AddCookie(call.cookie)
	}
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

func (f runnerFixture) expect(t *testing.T, call runnerCall, want int) *httptest.ResponseRecorder {
	t.Helper()
	rec := f.do(t, call)
	if rec.Code != want {
		t.Fatalf("%s %s: status=%d, want %d; body=%s", call.method, call.path, rec.Code, want, rec.Body.String())
	}
	return rec
}

func (f runnerFixture) pair(t *testing.T) RunnerPairing {
	t.Helper()
	rec := f.expect(t, runnerCall{method: http.MethodPost, path: "/api/runner-credential", cookie: f.cookie}, http.StatusCreated)
	var pairing RunnerPairing
	if err := json.Unmarshal(rec.Body.Bytes(), &pairing); err != nil {
		t.Fatal(err)
	}
	return pairing
}

func (f runnerFixture) health(t *testing.T) RunnerHealth {
	t.Helper()
	rec := f.expect(t, runnerCall{method: http.MethodGet, path: "/api/runner-health", cookie: f.cookie}, http.StatusOK)
	var health RunnerHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	return health
}

const registerBody = `{"michelinVersion":"0.1.0","hostname":"runner-host"}`

func (f runnerFixture) register(t *testing.T, token string, want int) *httptest.ResponseRecorder {
	t.Helper()
	return f.expect(t, runnerCall{method: http.MethodPost, path: "/api/runner/register", body: registerBody, token: token}, want)
}

func (f runnerFixture) heartbeat(t *testing.T, token string, want int) *httptest.ResponseRecorder {
	t.Helper()
	return f.expect(t, runnerCall{method: http.MethodPost, path: "/api/runner/heartbeat", token: token}, want)
}

func assertUnauthenticated(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body != newErrorBody("unauthenticated", "sign-in required") {
		t.Fatalf("401 body = %+v, want the shared unauthenticated body", body)
	}
}

func runnerRowCount(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM runners`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPairRunner_ReturnsTokenOnceAndStoresOnlyItsHash(t *testing.T) {
	f := newRunnerFixture(t)
	rec := f.expect(t, runnerCall{method: http.MethodPost, path: "/api/runner-credential", cookie: f.cookie}, http.StatusCreated)
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	var pairing RunnerPairing
	if err := json.Unmarshal(rec.Body.Bytes(), &pairing); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^tir_[A-Za-z0-9_-]{43}$`).MatchString(pairing.Token) {
		t.Fatalf("token %q is not tir_<43 base64url characters>", pairing.Token)
	}
	if pairing.Health.State != RunnerDisconnected || pairing.Health.PairedAt == nil || !pairing.Health.PairedAt.Equal(runnerEpoch) ||
		pairing.Health.LastSeenAt != nil || pairing.Health.RegisteredAt != nil {
		t.Fatalf("health after pairing = %+v", pairing.Health)
	}

	var stored []byte
	var row string
	if err := f.pool.QueryRow(context.Background(), `SELECT token_hash, row_to_json(runners)::text FROM runners`).Scan(&stored, &row); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(pairing.Token))
	if !bytes.Equal(stored, sum[:]) {
		t.Fatalf("stored hash %x is not SHA-256 of the full token", stored)
	}
	encoded := strings.TrimPrefix(pairing.Token, auth.RunnerTokenPrefix)
	if strings.Contains(row, encoded) || strings.Contains(row, pairing.Token) {
		t.Fatalf("the runners row holds the raw token: %s", row)
	}
	for _, path := range []string{"/api/runner-health", "/api/session"} {
		body := f.expect(t, runnerCall{method: http.MethodGet, path: path, cookie: f.cookie}, http.StatusOK).Body.String()
		if strings.Contains(body, encoded) {
			t.Fatalf("GET %s returned the token after issuance: %s", path, body)
		}
	}
}

func TestRunnerHealth_TransitionsAtTheThirtySecondBoundary(t *testing.T) {
	f := newRunnerFixture(t)
	if got := f.health(t); got.State != RunnerNotPaired || got.PairedAt != nil || got.LastSeenAt != nil || !got.CheckedAt.Equal(runnerEpoch) {
		t.Fatalf("health before pairing = %+v", got)
	}
	token := f.pair(t).Token
	if got := f.health(t); got.State != RunnerDisconnected || got.LastSeenAt != nil {
		t.Fatalf("health after pairing, before registering = %+v", got)
	}

	registeredAt := runnerEpoch.Add(5 * time.Second)
	f.clock.Set(registeredAt)
	f.register(t, token, http.StatusOK)
	got := f.health(t)
	if got.State != RunnerConnected || !got.LastSeenAt.Equal(registeredAt) || !got.RegisteredAt.Equal(registeredAt) ||
		*got.MichelinVersion != "0.1.0" || *got.Hostname != "runner-host" {
		t.Fatalf("health after registering = %+v", got)
	}

	for _, tc := range []struct {
		after time.Duration
		want  RunnerHealthState
	}{
		{29*time.Second + 999*time.Millisecond, RunnerConnected},
		{30*time.Second - time.Microsecond, RunnerConnected},
		{30 * time.Second, RunnerDisconnected},
		{time.Hour, RunnerDisconnected},
	} {
		f.clock.Set(registeredAt.Add(tc.after))
		got := f.health(t)
		if got.State != tc.want || !got.LastSeenAt.Equal(registeredAt) || !got.CheckedAt.Equal(registeredAt.Add(tc.after)) {
			t.Fatalf("%s after the last heartbeat: health = %+v, want %s with lastSeenAt %s", tc.after, got, tc.want, registeredAt)
		}
	}

	beat := registeredAt.Add(time.Hour + time.Second)
	f.clock.Set(beat)
	var ack RunnerHeartbeat
	if err := json.Unmarshal(f.heartbeat(t, token, http.StatusOK).Body.Bytes(), &ack); err != nil || !ack.LastSeenAt.Equal(beat) {
		t.Fatalf("heartbeat ack = %+v, %v", ack, err)
	}
	if got := f.health(t); got.State != RunnerConnected || !got.LastSeenAt.Equal(beat) || !got.RegisteredAt.Equal(registeredAt) {
		t.Fatalf("health after a heartbeat = %+v", got)
	}
	f.clock.Set(beat.Add(30 * time.Second))
	if got := f.health(t); got.State != RunnerDisconnected {
		t.Fatalf("health 30 s after the heartbeat = %+v", got)
	}
}

func TestRunnerCredential_WrongMalformedAndRevokedAre401(t *testing.T) {
	f := newRunnerFixture(t)
	token := f.pair(t).Token
	wrong, _, err := auth.NewRunnerToken()
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.TrimPrefix(token, auth.RunnerTokenPrefix)
	for name, header := range map[string]string{
		"wrong credential":  "Bearer " + wrong,
		"missing scheme":    token,
		"basic scheme":      "Basic " + token,
		"no prefix":         "Bearer " + encoded,
		"wrong prefix":      "Bearer tis_" + encoded,
		"truncated":         "Bearer " + token[:len(token)-1],
		"extended":          "Bearer " + token + "A",
		"padded":            "Bearer " + token + "=",
		"bad base64":        "Bearer tir_" + strings.Repeat("!", 43),
		"trailing space":    "Bearer " + token + " ",
		"empty bearer":      "Bearer ",
		"hash as token":     fmt.Sprintf("Bearer %x", sha256.Sum256([]byte(token))),
		"session as bearer": "Bearer " + f.cookie.Value,
	} {
		for _, path := range []string{"/api/runner/register", "/api/runner/heartbeat"} {
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(registerBody))
			req.Header.Set("Authorization", header)
			rec := httptest.NewRecorder()
			f.handler.ServeHTTP(rec, req)
			t.Run(name+" "+path, func(t *testing.T) { assertUnauthenticated(t, rec) })
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/runner/register", strings.NewReader(registerBody))
	req.Header.Add("Authorization", "Bearer "+token)
	req.Header.Add("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	assertUnauthenticated(t, rec)
	if got := f.health(t); got.RegisteredAt != nil {
		t.Fatalf("a rejected request registered the runner: %+v", got)
	}

	lower := httptest.NewRequest(http.MethodPost, "/api/runner/register", strings.NewReader(registerBody))
	lower.Header.Set("Authorization", "bearer "+token)
	rec = httptest.NewRecorder()
	f.handler.ServeHTTP(rec, lower)
	if rec.Code != http.StatusOK {
		t.Fatalf("lower-case scheme: status=%d; body=%s", rec.Code, rec.Body.String())
	}

	f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/runner-credential", cookie: f.cookie}, http.StatusNoContent)
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/heartbeat", token: token}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/register", body: registerBody, token: token}))
	if got := f.health(t); got.State != RunnerNotPaired {
		t.Fatalf("health after revoke = %+v", got)
	}
	if n := runnerRowCount(t, f.pool); n != 0 {
		t.Fatalf("runners rows after revoke = %d, want 0", n)
	}
	f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/runner-credential", cookie: f.cookie}, http.StatusNoContent)
}

func TestPairRunner_RepairingRevokesThePreviousCredential(t *testing.T) {
	f := newRunnerFixture(t)
	first := f.pair(t).Token
	f.register(t, first, http.StatusOK)
	f.clock.Set(runnerEpoch.Add(time.Minute))
	second := f.pair(t)
	if second.Token == first {
		t.Fatal("re-pairing returned the same token")
	}
	if second.Health.State != RunnerDisconnected || second.Health.RegisteredAt != nil || second.Health.LastSeenAt != nil ||
		!second.Health.PairedAt.Equal(runnerEpoch.Add(time.Minute)) {
		t.Fatalf("health after re-pairing = %+v, want a fresh unregistered runner", second.Health)
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/heartbeat", token: first}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/register", body: registerBody, token: first}))
	f.heartbeat(t, second.Token, http.StatusConflict)
	f.register(t, second.Token, http.StatusOK)
	f.heartbeat(t, second.Token, http.StatusOK)
	if n := runnerRowCount(t, f.pool); n != 1 {
		t.Fatalf("runners rows = %d, want 1", n)
	}
}

func TestPairRunner_ConcurrentPairsLeaveExactlyOneActiveCredential(t *testing.T) {
	f := newRunnerFixture(t)
	const pairs = 12
	for trial := range 3 {
		tokens := make([]string, pairs)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := range pairs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner-credential", cookie: f.cookie})
				if rec.Code != http.StatusCreated {
					t.Errorf("trial %d pair %d: status=%d; body=%s", trial, i, rec.Code, rec.Body.String())
					return
				}
				var pairing RunnerPairing
				if err := json.Unmarshal(rec.Body.Bytes(), &pairing); err != nil {
					t.Error(err)
				}
				tokens[i] = pairing.Token
			}()
		}
		close(start)
		wg.Wait()
		if t.Failed() {
			t.FailNow()
		}
		if n := runnerRowCount(t, f.pool); n != 1 {
			t.Fatalf("trial %d: runners rows = %d, want 1", trial, n)
		}
		active := 0
		for _, token := range tokens {
			switch rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/register", body: registerBody, token: token}); rec.Code {
			case http.StatusOK:
				active++
			case http.StatusUnauthorized:
			default:
				t.Fatalf("trial %d: register status=%d; body=%s", trial, rec.Code, rec.Body.String())
			}
		}
		if active != 1 {
			t.Fatalf("trial %d: %d of %d issued credentials authenticate, want exactly 1", trial, active, pairs)
		}
	}
}

func TestRunnerCredentials_OneActiveRowPerOwnerIsEnforcedByTheDatabase(t *testing.T) {
	f := newRunnerFixture(t)
	f.pair(t)
	_, hash, err := auth.NewRunnerToken()
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.pool.Exec(context.Background(), `INSERT INTO runners (owner_id, token_hash, paired_at) SELECT owner_id, $1, now() FROM runners`, hash)
	if err == nil || !strings.Contains(err.Error(), "runners_one_per_owner") {
		t.Fatalf("second runner row for one Owner: err = %v, want runners_one_per_owner violation", err)
	}
	_, err = f.pool.Exec(context.Background(), `UPDATE runners SET token_hash = $1`, []byte("tir_raw"))
	if err == nil || !strings.Contains(err.Error(), "runners_token_hash_sha256") {
		t.Fatalf("non-hash token_hash: err = %v, want runners_token_hash_sha256 violation", err)
	}
}

func TestRunnerEndpoints_RejectOwnerSessions(t *testing.T) {
	f := newRunnerFixture(t)
	token := f.pair(t).Token
	for _, path := range []string{"/api/runner/register", "/api/runner/heartbeat", "/api/runner/claims"} {
		for name, call := range map[string]runnerCall{
			"no credential":             {},
			"session cookie":            {cookie: f.cookie},
			"session cookie and bearer": {cookie: f.cookie, token: token},
		} {
			t.Run(path+" "+name, func(t *testing.T) {
				call.method, call.path, call.body = http.MethodPost, path, registerBody
				assertUnauthenticated(t, f.do(t, call))
			})
		}
	}
	if got := f.health(t); got.RegisteredAt != nil || got.LastSeenAt != nil {
		t.Fatalf("a rejected runner request changed the runner: %+v", got)
	}
	f.register(t, token, http.StatusOK)
	f.heartbeat(t, token, http.StatusOK)
}

var publicOperations = map[string]bool{"getStatus": true, "startGithubOAuth": true, "completeGithubOAuth": true}

func TestOwnerEndpoints_RejectRunnerBearerTokens(t *testing.T) {
	f := newRunnerFixture(t)
	token := f.pair(t).Token
	f.register(t, token, http.StatusOK)
	created := f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets", body: `{"title":"bearer boundary"}`, cookie: f.cookie}, http.StatusCreated)
	var ticket Ticket
	if err := json.Unmarshal(created.Body.Bytes(), &ticket); err != nil {
		t.Fatal(err)
	}
	badge := f.expect(t, runnerCall{method: http.MethodPost, path: "/api/badges", body: `{"name":"boundary"}`, cookie: f.cookie}, http.StatusCreated)
	var badgeID struct{ Id string }
	if err := json.Unmarshal(badge.Body.Bytes(), &badgeID); err != nil {
		t.Fatal(err)
	}
	agent := createAgentForTest(t, f.handler, f.cookie, "Boundary", AgentKindCoding)
	ticketsBefore := f.expect(t, runnerCall{method: http.MethodGet, path: "/api/tickets", cookie: f.cookie}, http.StatusOK).Body.String()
	agentsBefore := listAgentsForTest(t, f.handler, f.cookie)

	doc := loadContract(t)
	var covered []string
	for _, path := range doc.Paths.InMatchingOrder() {
		for method, op := range doc.Paths.Value(path).Operations() {
			if publicOperations[op.OperationID] || strings.HasPrefix(path, "/api/runner/") {
				continue
			}
			concrete := strings.NewReplacer("{id}", ticket.Id, "{badgeId}", badgeID.Id).Replace(path)
			if strings.HasPrefix(path, "/api/agents/") {
				concrete = "/api/agents/" + agent.Id
			}
			covered = append(covered, method+" "+path)
			for name, c := range map[string]struct {
				authorization string
				cookie        *http.Cookie
			}{
				"bearer only":           {"Bearer " + token, nil},
				"bearer and session":    {"Bearer " + token, f.cookie},
				"lowercase bearer":      {"bearer " + token, f.cookie},
				"uppercase bearer":      {"BEARER " + token, f.cookie},
				"malformed and session": {"Bearer not-a-runner-token", f.cookie},
			} {
				t.Run(op.OperationID+" "+name, func(t *testing.T) {
					req := httptest.NewRequest(method, concrete, strings.NewReader(`{}`))
					req.Header.Set("Content-Type", "application/json")
					req.Header.Set("Authorization", c.authorization)
					if c.cookie != nil {
						req.AddCookie(c.cookie)
					}
					rec := httptest.NewRecorder()
					f.handler.ServeHTTP(rec, req)
					assertUnauthenticated(t, rec)
					for _, c := range rec.Result().Cookies() {
						if c.Name == SessionCookieName {
							t.Fatalf("a bearer rejection touched the session cookie: %+v", c)
						}
					}
				})
			}
		}
	}
	sort.Strings(covered)
	t.Logf("Owner operations checked: %d: %s", len(covered), strings.Join(covered, ", "))
	if len(covered) < 20 {
		t.Fatalf("only %d Owner operations found in the contract", len(covered))
	}

	if got := f.health(t); got.State != RunnerConnected {
		t.Fatalf("a bearer on an Owner route revoked or changed the runner: %+v", got)
	}
	if after := f.expect(t, runnerCall{method: http.MethodGet, path: "/api/tickets", cookie: f.cookie}, http.StatusOK).Body.String(); after != ticketsBefore {
		t.Fatalf("Tickets changed through rejected requests:\nbefore %s\nafter  %s", ticketsBefore, after)
	}
	if after := listAgentsForTest(t, f.handler, f.cookie); !reflect.DeepEqual(after, agentsBefore) {
		t.Fatalf("Agents changed through rejected requests: %+v", after)
	}
	f.expect(t, runnerCall{method: http.MethodGet, path: "/api/session", cookie: f.cookie}, http.StatusOK)
}

func TestRegisterRunner_ValidatesTheBody(t *testing.T) {
	f := newRunnerFixture(t)
	token := f.pair(t).Token
	f.heartbeat(t, token, http.StatusConflict)
	for _, body := range []string{
		``,
		`{}`,
		`[]`,
		`{"michelinVersion":"0.1.0"}`,
		`{"hostname":"h"}`,
		`{"michelinVersion":"","hostname":"h"}`,
		`{"michelinVersion":"0.1.0","hostname":"   "}`,
		`{"michelinVersion":null,"hostname":"h"}`,
		`{"michelinVersion":"0.1.0","hostname":"h","token":"x"}`,
		`{"michelinVersion":"0.1.0","hostname":"h\nforged"}`,
		fmt.Sprintf(`{"michelinVersion":%q,"hostname":"h"}`, strings.Repeat("9", 65)),
		fmt.Sprintf(`{"michelinVersion":"0.1.0","hostname":%q}`, strings.Repeat("h", 254)),
		`{"michelinVersion":"0.1.0","hostname":"h"} {}`,
	} {
		rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/register", body: body, token: token})
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_request"`) {
			t.Fatalf("body %q: status=%d; body=%s", body, rec.Code, rec.Body.String())
		}
	}
	if got := f.health(t); got.RegisteredAt != nil {
		t.Fatalf("an invalid registration registered the runner: %+v", got)
	}
	f.expect(t, runnerCall{method: http.MethodPost, path: "/api/runner/register", body: fmt.Sprintf(`{"michelinVersion":" %s ","hostname":%q}`, strings.Repeat("9", 64), strings.Repeat("h", 253)), token: token}, http.StatusOK)
	if got := f.health(t); *got.MichelinVersion != strings.Repeat("9", 64) || *got.Hostname != strings.Repeat("h", 253) {
		t.Fatalf("registration at the length limits = %+v", got)
	}
}

func TestRunnerDisconnect_ChangesNoTicket(t *testing.T) {
	f := newRunnerFixture(t)
	token := f.pair(t).Token
	f.register(t, token, http.StatusOK)
	agent := createAgentForTest(t, f.handler, f.cookie, "Runner Agent", AgentKindCoding)
	for i, path := range [][]string{
		{},
		{"Ready"},
		{"Ready", "InProgress"},
		{"Ready", "InProgress", "Blocked"},
		{"Ready", "InProgress", "InReview"},
	} {
		rec := f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets", body: fmt.Sprintf(`{"title":"disconnect %d","template":"Coding"}`, i), cookie: f.cookie}, http.StatusCreated)
		var ticket Ticket
		if err := json.Unmarshal(rec.Body.Bytes(), &ticket); err != nil {
			t.Fatal(err)
		}
		f.expect(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + ticket.Id, body: `{"goal":"g","successCriteria":"s","repository":"octo/repo"}`, cookie: f.cookie}, http.StatusOK)
		for _, status := range path {
			f.expect(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + ticket.Id + "/status", body: fmt.Sprintf(`{"status":%q}`, status), cookie: f.cookie}, http.StatusOK)
		}
		f.expect(t, runnerCall{method: http.MethodPut, path: "/api/tickets/" + ticket.Id + "/assignee", body: assignAgentBody(agent.Id), cookie: f.cookie}, http.StatusOK)
	}
	snapshot := func() (string, string, map[string]int64) {
		api := f.expect(t, runnerCall{method: http.MethodGet, path: "/api/tickets", cookie: f.cookie}, http.StatusOK).Body.String()
		var rows string
		if err := f.pool.QueryRow(context.Background(), `SELECT coalesce(json_agg(t ORDER BY id)::text, '') FROM tickets t`).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		counts := map[string]int64{}
		for _, table := range knownPublicTables {
			counts[table] = tableRowCount(t, f.pool, table)
		}
		return api, rows, counts
	}
	apiBefore, rowsBefore, countsBefore := snapshot()
	if got := f.health(t); got.State != RunnerConnected {
		t.Fatalf("health before the window = %+v", got)
	}
	for _, after := range []time.Duration{31 * time.Second, time.Hour, 48 * time.Hour} {
		f.clock.Set(runnerEpoch.Add(after))
		if got := f.health(t); got.State != RunnerDisconnected {
			t.Fatalf("health %s after the last heartbeat = %+v", after, got)
		}
	}
	apiAfter, rowsAfter, countsAfter := snapshot()
	if apiAfter != apiBefore {
		t.Fatalf("Ticket API changed across disconnect:\nbefore %s\nafter  %s", apiBefore, apiAfter)
	}
	if rowsAfter != rowsBefore {
		t.Fatalf("tickets rows changed across disconnect:\nbefore %s\nafter  %s", rowsBefore, rowsAfter)
	}
	if !reflect.DeepEqual(countsAfter, countsBefore) {
		t.Fatalf("table row counts changed across disconnect: before %v after %v", countsBefore, countsAfter)
	}
	var statuses []string
	var list TicketList
	if err := json.Unmarshal([]byte(apiAfter), &list); err != nil {
		t.Fatal(err)
	}
	for _, ticket := range list.Tickets {
		statuses = append(statuses, string(ticket.Status))
	}
	sort.Strings(statuses)
	if want := []string{"Backlog", "Blocked", "InProgress", "InReview", "Ready"}; !reflect.DeepEqual(statuses, want) {
		t.Fatalf("statuses after disconnect = %v, want %v", statuses, want)
	}
}

func TestAdvanceDevClock_MovesRunnerHealthInDevelopmentOnly(t *testing.T) {
	pool := postgres.NewEmptyMigratedTestPool(t)
	cookie := mintTestSessionCookie(t, pool)
	dev := runnerFixture{handler: NewHandler(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), pool, testLogger(&bytes.Buffer{})), pool: pool, cookie: cookie}
	token := dev.pair(t).Token
	dev.register(t, token, http.StatusOK)
	if got := dev.health(t); got.State != RunnerConnected {
		t.Fatalf("health after registering = %+v", got)
	}
	assertUnauthenticated(t, dev.do(t, runnerCall{method: http.MethodPost, path: "/api/dev/clock/advance", body: `{"seconds":30}`}))
	for _, body := range []string{`{}`, `{"seconds":0}`, `{"seconds":-5}`, `{"seconds":86401}`, `{"seconds":1.5}`} {
		dev.expect(t, runnerCall{method: http.MethodPost, path: "/api/dev/clock/advance", body: body, cookie: cookie}, http.StatusBadRequest)
	}
	rec := dev.expect(t, runnerCall{method: http.MethodPost, path: "/api/dev/clock/advance", body: `{"seconds":30}`, cookie: cookie}, http.StatusOK)
	var clock DevClock
	if err := json.Unmarshal(rec.Body.Bytes(), &clock); err != nil {
		t.Fatal(err)
	}
	if skew := clock.Now.Sub(time.Now()); skew < 29*time.Second || skew > 31*time.Second {
		t.Fatalf("dev clock is %s ahead, want about 30 s", skew)
	}
	if got := dev.health(t); got.State != RunnerDisconnected {
		t.Fatalf("health after advancing 30 s = %+v", got)
	}
	dev.heartbeat(t, token, http.StatusOK)
	if got := dev.health(t); got.State != RunnerConnected {
		t.Fatalf("health after a heartbeat on the advanced clock = %+v", got)
	}

	injected := newRunnerFixture(t)
	injected.expect(t, runnerCall{method: http.MethodPost, path: "/api/dev/clock/advance", body: `{"seconds":30}`, cookie: injected.cookie}, http.StatusNotFound)

	production := runnerFixture{handler: NewHandler(config.Config{Environment: config.EnvProduction, Version: "1.0.0"}, time.Now(), pool, testLogger(&bytes.Buffer{})), pool: pool, cookie: cookie}
	rec = production.expect(t, runnerCall{method: http.MethodPost, path: "/api/dev/clock/advance", body: `{"seconds":30}`, cookie: cookie}, http.StatusNotFound)
	if rec.Header().Get("Allow") != "" {
		t.Fatalf("production knows the dev clock path: Allow=%q", rec.Header().Get("Allow"))
	}
	production.heartbeat(t, token, http.StatusOK)
	if got := production.health(t); got.State != RunnerConnected {
		t.Fatalf("production health = %+v", got)
	}
}

func TestOwnerEndpoints_AcceptNonBearerAuthorizationBesideASession(t *testing.T) {
	f := newRunnerFixture(t)
	doc := loadContract(t)
	var covered int
	for _, path := range doc.Paths.InMatchingOrder() {
		op := doc.Paths.Value(path).Get
		if op == nil || publicOperations[op.OperationID] || strings.HasPrefix(path, "/api/runner/") || strings.Contains(path, "{") {
			continue
		}
		covered++
		for _, authorization := range []string{"Basic b3duZXI6cHJveHk=", "Digest username=\"owner\""} {
			t.Run(op.OperationID+" "+strings.Fields(authorization)[0], func(t *testing.T) {
				req := httptest.NewRequest(http.MethodGet, path, nil)
				req.Header.Set("Authorization", authorization)
				req.AddCookie(f.cookie)
				rec := httptest.NewRecorder()
				f.handler.ServeHTTP(rec, req)
				if rec.Code != http.StatusOK {
					t.Fatalf("GET %s with Authorization %q: status=%d, want 200; body=%s", path, authorization, rec.Code, rec.Body)
				}
			})
		}
	}
	if covered < 5 {
		t.Fatalf("only %d parameterless Owner GET operations found in the contract", covered)
	}
}
