package httpapi

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
	"github.com/cristoforows/ticketIt/apps/galley/internal/postgres"
)

// priorityFixture runs on its own empty database, so the Owner's whole
// priority order is known to the test.
type priorityFixture struct {
	pool    *pgxpool.Pool
	ownerID int64
	baseURL string
	client  *http.Client
	ids     map[string]string
	names   map[string]string
}

func newPriorityFixture(t *testing.T) *priorityFixture {
	t.Helper()
	pool := postgres.NewEmptyMigratedTestPool(t)
	srv := httptest.NewServer(NewHandler(config.Config{Environment: config.EnvDevelopment}, time.Now(), pool, testLogger(&bytes.Buffer{})))
	t.Cleanup(srv.Close)
	return &priorityFixture{
		pool:    pool,
		ownerID: resolveTestOwner(t, pool),
		baseURL: srv.URL,
		client:  clientWithCookie(t, srv.URL, mintTestSessionCookie(t, pool)),
		ids:     map[string]string{},
		names:   map[string]string{},
	}
}

func clientWithCookie(t *testing.T, baseURL string, cookie *http.Cookie) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(u, []*http.Cookie{cookie})
	return &http.Client{Jar: jar}
}

func (f *priorityFixture) capture(t *testing.T, name string) string {
	t.Helper()
	id := createTicket(t, f.client, f.baseURL, name).Id
	f.ids[name], f.names[id] = id, name
	return id
}

func (f *priorityFixture) apply(t *testing.T, name, step string) {
	t.Helper()
	id := f.ids[name]
	var resp lifecycleResult
	switch step {
	case "accept", "archive", "restore":
		resp = doLifecycleRequest(t, f.client, http.MethodPost, f.baseURL+"/api/tickets/"+id+"/"+step, nil)
	default:
		resp = changeStatus(t, f.client, f.baseURL, id, TicketStatus(step))
	}
	if resp.status != http.StatusOK {
		t.Fatalf("%s %s: status = %d, error = %+v", step, name, resp.status, resp.errBody)
	}
}

func (f *priorityFixture) reorder(t *testing.T, id string, body any) lifecycleResult {
	t.Helper()
	return doLifecycleRequest(t, f.client, http.MethodPost, f.baseURL+"/api/tickets/"+id+"/position", body)
}

func (f *priorityFixture) stage(t *testing.T, status TicketStatus) []string {
	t.Helper()
	var names []string
	for _, ticket := range listTickets(t, f.client, f.baseURL) {
		if ticket.Status == status {
			names = append(names, f.names[ticket.Id])
		}
	}
	return names
}

func (f *priorityFixture) ranks(t *testing.T) map[string]int64 {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT public_id::text, priority_rank FROM tickets WHERE owner_id = $1`, f.ownerID)
	if err != nil {
		t.Fatal(err)
	}
	ranks := map[string]int64{}
	for rows.Next() {
		var id string
		var rank int64
		if err := rows.Scan(&id, &rank); err != nil {
			t.Fatal(err)
		}
		ranks[f.nameOf(id)] = rank
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ranks
}

func (f *priorityFixture) nameOf(id string) string {
	if name, ok := f.names[id]; ok {
		return name
	}
	return id
}

func (f *priorityFixture) setRanks(t *testing.T, ranks map[string]int64) {
	t.Helper()
	ids, values := []string{}, []int64{}
	for name, rank := range ranks {
		ids, values = append(ids, f.ids[name]), append(values, rank)
	}
	tag, err := f.pool.Exec(context.Background(),
		`UPDATE tickets SET priority_rank = fixture.rank
		   FROM unnest($2::uuid[], $3::bigint[]) AS fixture(public_id, rank)
		  WHERE tickets.owner_id = $1 AND tickets.public_id = fixture.public_id`,
		f.ownerID, ids, values)
	if err != nil || tag.RowsAffected() != int64(len(ranks)) {
		t.Fatalf("setRanks: %v, %d rows", err, tag.RowsAffected())
	}
}

// assertStrictOrder checks the whole collection: ranks are distinct and
// the active list is the rank order.
func (f *priorityFixture) assertStrictOrder(t *testing.T) {
	t.Helper()
	rows, err := f.pool.Query(context.Background(),
		`SELECT public_id::text, priority_rank, archived_at IS NOT NULL FROM tickets WHERE owner_id = $1 ORDER BY priority_rank, id`, f.ownerID)
	if err != nil {
		t.Fatal(err)
	}
	var active []string
	var previous *int64
	for rows.Next() {
		var id string
		var rank int64
		var archived bool
		if err := rows.Scan(&id, &rank, &archived); err != nil {
			t.Fatal(err)
		}
		if previous != nil && *previous >= rank {
			t.Errorf("rank %d follows %d: ranks are not strictly increasing", rank, *previous)
		}
		previous = &rank
		if !archived {
			active = append(active, id)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	var listed []string
	for _, ticket := range listTickets(t, f.client, f.baseURL) {
		listed = append(listed, ticket.Id)
	}
	if !slices.Equal(listed, active) {
		t.Errorf("GET /api/tickets order = %v, want rank order %v", listed, active)
	}
}

func TestPriorityGap_Midpoint(t *testing.T) {
	rank := func(v int64) *int64 { return &v }
	for _, tc := range []struct {
		name         string
		gap          priorityGap
		want         int64
		wantHasSpace bool
	}{
		{"no neighbour above", priorityGap{upper: rank(2048)}, 1024, true},
		{"no neighbour below", priorityGap{lower: rank(1024)}, 2048, true},
		{"spaced neighbours", priorityGap{rank(1024), rank(2048)}, 1536, true},
		{"one free rank", priorityGap{rank(1024), rank(1026)}, 1025, true},
		{"adjacent ranks", priorityGap{rank(1024), rank(1025)}, 0, false},
		{"negative ranks", priorityGap{rank(-5), rank(-2)}, -4, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := tc.gap.midpoint()
			if got != tc.want || ok != tc.wantHasSpace {
				t.Fatalf("midpoint() = (%d, %t), want (%d, %t)", got, ok, tc.want, tc.wantHasSpace)
			}
		})
	}
}

func TestPriorityPlacement_CaptureTopReadyBottomOtherwiseKept(t *testing.T) {
	type placement string
	const (
		top, bottom, kept placement = "top", "bottom", "kept"
	)
	f := newPriorityFixture(t)
	for _, tc := range []struct {
		name  string
		setup []string
		act   string
		want  placement
	}{
		{"capture", nil, "capture", top},
		{"Backlog to Ready", nil, "Ready", bottom},
		{"Ready to Backlog", []string{"Ready"}, "Backlog", kept},
		{"Ready to In Progress", []string{"Ready"}, "InProgress", kept},
		{"In Progress to Blocked", []string{"Ready", "InProgress"}, "Blocked", kept},
		{"Backlog to Blocked", nil, "Blocked", kept},
		{"Blocked to In Progress", []string{"Blocked"}, "InProgress", kept},
		{"In Review to In Progress", []string{"Ready", "InProgress", "InReview"}, "InProgress", kept},
		{"In Progress to In Review", []string{"Ready", "InProgress"}, "InReview", kept},
		{"Accept to Done", []string{"Ready", "InProgress", "InReview"}, "accept", kept},
		{"In Progress back to Ready", []string{"Ready", "InProgress"}, "Ready", bottom},
		{"Done back to Ready", []string{"Ready", "InProgress", "InReview", "accept"}, "Ready", bottom},
		{"archive", []string{"Ready", "InProgress"}, "archive", kept},
		{"restore", []string{"Ready", "InProgress", "archive"}, "restore", kept},
		{"restore of a Ready Ticket to Backlog", []string{"Ready", "archive"}, "restore", kept},
	} {
		t.Run(tc.name, func(t *testing.T) {
			subject := tc.name
			f.capture(t, subject)
			for _, step := range tc.setup {
				f.apply(t, subject, step)
			}
			f.capture(t, subject+" filler above")
			f.capture(t, subject+" filler below")
			f.apply(t, subject+" filler below", "Ready")
			before := f.ranks(t)

			if tc.act == "capture" {
				subject += " captured"
				f.capture(t, subject)
			} else {
				f.apply(t, subject, tc.act)
			}

			after := f.ranks(t)
			lowest, highest := after[subject], after[subject]
			for _, rank := range after {
				lowest, highest = min(lowest, rank), max(highest, rank)
			}
			switch tc.want {
			case top:
				if after[subject] != lowest {
					t.Errorf("rank = %d, want the lowest (%d)", after[subject], lowest)
				}
			case bottom:
				if after[subject] != highest || after[subject] == before[subject] {
					t.Errorf("rank = %d (was %d), want a new highest rank (%d)", after[subject], before[subject], highest)
				}
			case kept:
				if after[subject] != before[subject] {
					t.Errorf("rank = %d, want it kept at %d", after[subject], before[subject])
				}
			}
			for name, rank := range before {
				if name != subject && after[name] != rank {
					t.Errorf("%s rank changed from %d to %d", name, rank, after[name])
				}
			}
			f.assertStrictOrder(t)
		})
	}
}

func TestReorder_BeforeAndAfterWithinStageWithInterleavedStages(t *testing.T) {
	f := newPriorityFixture(t)
	for _, name := range []string{"R1", "B1", "R2", "B2", "R3", "B3"} {
		f.capture(t, name)
	}
	for _, name := range []string{"R1", "R2", "R3"} {
		f.apply(t, name, "Ready")
	}
	interleaved := map[string]int64{"R1": 1024, "B1": 2048, "R2": 3072, "B2": 4096, "R3": 5120, "B3": 6144}

	for _, tc := range []struct {
		moved, placement, anchor string
		wantReady                []string
	}{
		{"R3", "before", "R1", []string{"R3", "R1", "R2"}},
		{"R3", "before", "R2", []string{"R1", "R3", "R2"}},
		{"R1", "after", "R3", []string{"R2", "R3", "R1"}},
		{"R1", "after", "R2", []string{"R2", "R1", "R3"}},
		{"R2", "before", "R1", []string{"R2", "R1", "R3"}},
		{"R2", "after", "R3", []string{"R1", "R3", "R2"}},
		{"R1", "before", "R2", []string{"R1", "R2", "R3"}},
		{"R2", "before", "R3", []string{"R1", "R2", "R3"}},
		{"R3", "after", "R2", []string{"R1", "R2", "R3"}},
	} {
		t.Run(fmt.Sprintf("%s %s %s", tc.moved, tc.placement, tc.anchor), func(t *testing.T) {
			f.setRanks(t, interleaved)
			resp := f.reorder(t, f.ids[tc.moved], map[string]string{tc.placement: f.ids[tc.anchor]})
			if resp.status != http.StatusOK || resp.ticket.Id != f.ids[tc.moved] {
				t.Fatalf("status = %d, ticket = %s, error = %+v", resp.status, resp.ticket.Id, resp.errBody)
			}
			if got := f.stage(t, Ready); !slices.Equal(got, tc.wantReady) {
				t.Errorf("Ready = %v, want %v", got, tc.wantReady)
			}
			if got := f.stage(t, Backlog); !slices.Equal(got, []string{"B1", "B2", "B3"}) {
				t.Errorf("Backlog = %v, want it untouched", got)
			}
			f.assertStrictOrder(t)
		})
	}
}

func TestReorder_RepeatingAMoveKeepsTheRank(t *testing.T) {
	f := newPriorityFixture(t)
	for _, name := range []string{"A", "B"} {
		f.capture(t, name)
		f.apply(t, name, "Ready")
	}
	for range 3 {
		if resp := f.reorder(t, f.ids["B"], map[string]string{"before": f.ids["A"]}); resp.status != http.StatusOK {
			t.Fatalf("status = %d, error = %+v", resp.status, resp.errBody)
		}
	}
	first := f.ranks(t)
	if resp := f.reorder(t, f.ids["B"], map[string]string{"before": f.ids["A"]}); resp.status != http.StatusOK {
		t.Fatalf("status = %d, error = %+v", resp.status, resp.errBody)
	}
	if again := f.ranks(t); again["B"] != first["B"] {
		t.Errorf("repeating the move changed B's rank from %d to %d", first["B"], again["B"])
	}
}

func TestReorder_RejectionsLeaveTheOrderUnchanged(t *testing.T) {
	f := newPriorityFixture(t)
	for _, name := range []string{"moved", "anchor", "backlog", "archived anchor", "archived"} {
		f.capture(t, name)
	}
	for _, name := range []string{"moved", "anchor", "archived anchor", "archived"} {
		f.apply(t, name, "Ready")
	}
	f.apply(t, "archived anchor", "archive")
	f.apply(t, "archived", "archive")
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := createTicket(t, clientWithCookie(t, f.baseURL, foreignCookie), f.baseURL, "foreign").Id
	changeStatus(t, clientWithCookie(t, f.baseURL, foreignCookie), f.baseURL, foreign, Ready)

	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	anchorBody := func(key, id string) json.RawMessage { return raw(fmt.Sprintf(`{%q:%q}`, key, id)) }
	moved, anchor := f.ids["moved"], f.ids["anchor"]
	for _, tc := range []struct {
		name       string
		moved      string
		body       json.RawMessage
		wantStatus int
		wantCode   string
	}{
		{"both before and after", moved, raw(fmt.Sprintf(`{"before":%q,"after":%q}`, anchor, anchor)), 400, "invalid_request"},
		{"neither before nor after", moved, raw(`{}`), 400, "invalid_request"},
		{"null anchor", moved, raw(`{"before":null}`), 400, "invalid_request"},
		{"unknown property", moved, anchorBody("above", anchor), 400, "invalid_request"},
		{"unknown anchor", moved, anchorBody("before", uuid.NewString()), 400, reorderAnchorInvalidCode},
		{"malformed anchor", moved, anchorBody("after", "not-a-uuid"), 400, reorderAnchorInvalidCode},
		{"foreign anchor", moved, anchorBody("before", foreign), 400, reorderAnchorInvalidCode},
		{"archived anchor", moved, anchorBody("before", f.ids["archived anchor"]), 400, reorderAnchorInvalidCode},
		{"anchor in another Status", moved, anchorBody("after", f.ids["backlog"]), 400, reorderAnchorInvalidCode},
		{"anchor is the moved Ticket", moved, anchorBody("before", moved), 400, reorderAnchorInvalidCode},
		{"archived moved Ticket", f.ids["archived"], anchorBody("before", anchor), 400, archivedTicketCode},
		{"unknown moved Ticket", uuid.NewString(), anchorBody("before", anchor), 404, "not_found"},
		{"malformed moved Ticket", "not-a-uuid", anchorBody("before", anchor), 404, "not_found"},
		{"foreign moved Ticket", foreign, anchorBody("before", anchor), 404, "not_found"},
		{"unknown moved Ticket with a malformed anchor", uuid.NewString(), anchorBody("before", "not-a-uuid"), 404, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := f.ranks(t)
			resp := f.reorder(t, tc.moved, tc.body)
			if resp.status != tc.wantStatus || resp.errBody.Error.Code != tc.wantCode {
				t.Fatalf("status = %d, error = %+v; want %d %s", resp.status, resp.errBody, tc.wantStatus, tc.wantCode)
			}
			if after := f.ranks(t); !mapsEqual(before, after) {
				t.Errorf("ranks changed from %v to %v", before, after)
			}
		})
	}
	if resp := f.reorder(t, moved, anchorBody("after", anchor)); resp.status != http.StatusOK {
		t.Fatalf("the valid move after the rejections: status = %d, error = %+v", resp.status, resp.errBody)
	}
}

func mapsEqual(a, b map[string]int64) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

func TestReorder_NoGapRenumbersTheWholeCollectionInOrder(t *testing.T) {
	f := newPriorityFixture(t)
	for _, name := range []string{"A", "B", "C", "archived", "backlog"} {
		f.capture(t, name)
	}
	for _, name := range []string{"A", "B", "C", "archived"} {
		f.apply(t, name, "Ready")
	}
	f.apply(t, "archived", "archive")
	f.setRanks(t, map[string]int64{"A": 1024, "B": 1025, "archived": 1026, "backlog": 1027, "C": 5000})

	if resp := f.reorder(t, f.ids["C"], map[string]string{"after": f.ids["A"]}); resp.status != http.StatusOK {
		t.Fatalf("status = %d, error = %+v", resp.status, resp.errBody)
	}

	ranks := f.ranks(t)
	order := []string{"A", "B", "archived", "backlog", "C"}
	slices.SortFunc(order, func(a, b string) int { return cmp.Compare(ranks[a], ranks[b]) })
	if want := []string{"A", "C", "B", "archived", "backlog"}; !slices.Equal(order, want) {
		t.Errorf("whole order = %v, want %v", order, want)
	}
	for _, name := range []string{"A", "B", "archived", "backlog"} {
		if ranks[name]%priorityRankSpacing != 0 {
			t.Errorf("%s rank = %d, want a multiple of %d after renumbering", name, ranks[name], priorityRankSpacing)
		}
	}
	f.assertStrictOrder(t)
}

func TestReorder_RepeatedMovesIntoOneGapRenumberAndKeepOrder(t *testing.T) {
	f := newPriorityFixture(t)
	movers := []string{}
	for _, name := range []string{"A", "B"} {
		f.capture(t, name)
		f.apply(t, name, "Ready")
	}
	for i := range 12 {
		name := fmt.Sprintf("M%02d", i)
		movers = append(movers, name)
		f.capture(t, name)
		f.apply(t, name, "Ready")
	}
	originalB := f.ranks(t)["B"]

	for _, name := range movers {
		if resp := f.reorder(t, f.ids[name], map[string]string{"after": f.ids["A"]}); resp.status != http.StatusOK {
			t.Fatalf("move %s: status = %d, error = %+v", name, resp.status, resp.errBody)
		}
	}

	want := []string{"A"}
	for i := len(movers) - 1; i >= 0; i-- {
		want = append(want, movers[i])
	}
	want = append(want, "B")
	if got := f.stage(t, Ready); !slices.Equal(got, want) {
		t.Errorf("Ready = %v, want %v", got, want)
	}
	if f.ranks(t)["B"] == originalB {
		t.Errorf("B kept rank %d; twelve halvings of a 1024 gap should have forced a renumber", originalB)
	}
	f.assertStrictOrder(t)
}

type concurrentRequest struct {
	path string
	body any
}

func (f *priorityFixture) race(t *testing.T, requests []concurrentRequest) []string {
	t.Helper()
	start := make(chan struct{})
	failures := make(chan string, len(requests))
	var wg sync.WaitGroup
	for _, r := range requests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var data []byte
			if r.body != nil {
				data, _ = json.Marshal(r.body)
			}
			<-start
			resp, err := f.client.Post(f.baseURL+r.path, "application/json", bytes.NewReader(data))
			if err != nil {
				failures <- fmt.Sprintf("POST %s: %v", r.path, err)
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
				failures <- fmt.Sprintf("POST %s %s: %d %s", r.path, data, resp.StatusCode, body)
			}
		}()
	}
	close(start)
	wg.Wait()
	close(failures)
	var got []string
	for failure := range failures {
		got = append(got, failure)
	}
	return got
}

func TestReorder_ConcurrentReordersKeepAStrictTotalOrder(t *testing.T) {
	f := newPriorityFixture(t)
	var ready []string
	for i := range 8 {
		name := fmt.Sprintf("R%d", i)
		ready = append(ready, name)
		f.capture(t, name)
		f.apply(t, name, "Ready")
	}
	seed := uint64(time.Now().UnixNano())
	t.Logf("seed %d", seed)
	random := rand.New(rand.NewPCG(seed, seed))

	for round := range 5 {
		var requests []concurrentRequest
		for range 16 {
			moved, anchor := random.IntN(len(ready)), random.IntN(len(ready)-1)
			if anchor >= moved {
				anchor++
			}
			placement := []string{"before", "after"}[random.IntN(2)]
			requests = append(requests, concurrentRequest{
				path: "/api/tickets/" + f.ids[ready[moved]] + "/position",
				body: map[string]string{placement: f.ids[ready[anchor]]},
			})
		}
		if failures := f.race(t, requests); len(failures) > 0 {
			t.Fatalf("round %d: %d of %d reorders failed: %v", round, len(failures), len(requests), failures)
		}
		got := f.stage(t, Ready)
		if sorted := slices.Sorted(slices.Values(got)); !slices.Equal(sorted, ready) {
			t.Fatalf("round %d: Ready = %v, want a permutation of %v", round, got, ready)
		}
		f.assertStrictOrder(t)
	}
}

func TestPriority_ConcurrentReorderCaptureAndReadyEntry(t *testing.T) {
	f := newPriorityFixture(t)
	var ready, backlog []string
	for i := range 5 {
		name := fmt.Sprintf("R%d", i)
		ready = append(ready, name)
		f.capture(t, name)
		f.apply(t, name, "Ready")
	}
	for i := range 6 {
		name := fmt.Sprintf("B%d", i)
		backlog = append(backlog, name)
		f.capture(t, name)
	}
	existing := len(f.ids)

	var requests []concurrentRequest
	for i := range 6 {
		requests = append(requests,
			concurrentRequest{"/api/tickets", CreateTicketRequest{Title: fmt.Sprintf("captured %d", i)}},
			concurrentRequest{"/api/tickets/" + f.ids[backlog[i]] + "/status", ChangeTicketStatusRequest{Status: Ready}},
			concurrentRequest{"/api/tickets/" + f.ids[ready[i%5]] + "/position", map[string]string{"after": f.ids[ready[(i+2)%5]]}},
			concurrentRequest{"/api/tickets/" + f.ids[ready[(i+1)%5]] + "/position", map[string]string{"before": f.ids[ready[(i+4)%5]]}},
		)
	}
	if failures := f.race(t, requests); len(failures) > 0 {
		t.Fatalf("%d of %d requests failed: %v", len(failures), len(requests), failures)
	}

	ranks := f.ranks(t)
	if len(ranks) != existing+6 {
		t.Fatalf("%d Tickets, want %d", len(ranks), existing+6)
	}
	highestCaptured, lowestExisting := int64(-1<<63), int64(1<<63-1)
	for name, rank := range ranks {
		if _, known := f.ids[name]; known {
			lowestExisting = min(lowestExisting, rank)
		} else {
			highestCaptured = max(highestCaptured, rank)
		}
	}
	if highestCaptured >= lowestExisting {
		t.Errorf("a captured Ticket ranks %d, below an existing Ticket at %d", highestCaptured, lowestExisting)
	}
	if got := f.stage(t, Ready); len(got) != len(ready)+len(backlog) {
		t.Errorf("Ready = %v, want all %d Tickets", got, len(ready)+len(backlog))
	}
	f.assertStrictOrder(t)
}

func TestPriority_ConcurrentAcceptsAndStatusChangesOnDifferentTicketsAllSucceed(t *testing.T) {
	f := newPriorityFixture(t)
	var requests []concurrentRequest
	for i := range 6 {
		review, progress, backlog := fmt.Sprintf("V%d", i), fmt.Sprintf("P%d", i), fmt.Sprintf("B%d", i)
		for _, name := range []string{review, progress, backlog} {
			f.capture(t, name)
		}
		for _, step := range []string{"Ready", "InProgress", "InReview"} {
			f.apply(t, review, step)
		}
		for _, step := range []string{"Ready", "InProgress"} {
			f.apply(t, progress, step)
		}
		requests = append(requests,
			concurrentRequest{"/api/tickets/" + f.ids[review] + "/accept", nil},
			concurrentRequest{"/api/tickets/" + f.ids[progress] + "/status", ChangeTicketStatusRequest{Status: Blocked}},
			concurrentRequest{"/api/tickets/" + f.ids[backlog] + "/status", ChangeTicketStatusRequest{Status: Ready}},
		)
	}
	if failures := f.race(t, requests); len(failures) > 0 {
		t.Fatalf("%d of %d requests failed: %v", len(failures), len(requests), failures)
	}
	for status, want := range map[TicketStatus]int{Done: 6, Blocked: 6, Ready: 6} {
		if got := f.stage(t, status); len(got) != want {
			t.Errorf("%s = %v, want %d Tickets", status, got, want)
		}
	}
	f.assertStrictOrder(t)
}
