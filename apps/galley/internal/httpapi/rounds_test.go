package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type claimFixture struct {
	runnerFixture
	agent Agent
	token string
}

func newClaimFixture(t *testing.T) *claimFixture {
	t.Helper()
	f := &claimFixture{runnerFixture: newRunnerFixture(t)}
	f.agent = createAgentForTest(t, f.handler, f.cookie, "Researcher", AgentKindResearch)
	f.token = f.pair(t).Token
	f.register(t, f.token, http.StatusOK)
	return f
}

func queueTicketAs(t *testing.T, handler http.Handler, cookie *http.Cookie, agent Agent, title string) Ticket {
	t.Helper()
	body, _, _ := badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets",
		fmt.Sprintf(`{"title":%q,"goal":"Find the cause","successCriteria":"A written cause","context":"ctx","constraints":"none"}`, title), http.StatusCreated)
	id := decodeAs[Ticket](t, body).Id
	badgeRequest(t, handler, cookie, http.MethodPut, "/api/tickets/"+id+"/assignee", assignAgentBody(agent.Id), http.StatusOK)
	body, _, _ = badgeRequest(t, handler, cookie, http.MethodPost, "/api/tickets/"+id+"/status", `{"status":"Ready"}`, http.StatusOK)
	ticket := decodeAs[Ticket](t, body)
	if !ticket.RequestingAgentWork || ticket.OpenRound != nil {
		t.Fatalf("queued Ticket = %+v, want requesting Agent work with no open Round", ticket)
	}
	return ticket
}

func (f *claimFixture) queue(t *testing.T, title string) Ticket {
	t.Helper()
	return queueTicketAs(t, f.handler, f.cookie, f.agent, title)
}

func (f *claimFixture) claim(t *testing.T) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", token: f.token})
}

func decodeClaim(t *testing.T, rec *httptest.ResponseRecorder) RunnerClaim {
	t.Helper()
	if rec.Code != http.StatusCreated {
		t.Fatalf("claim: status=%d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	var claim RunnerClaim
	if err := json.Unmarshal(rec.Body.Bytes(), &claim); err != nil {
		t.Fatal(err)
	}
	return claim
}

func (f *claimFixture) mustClaim(t *testing.T) RunnerClaim {
	t.Helper()
	return decodeClaim(t, f.claim(t))
}

func assertNoWork(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("claim: status=%d body=%q, want 204 with no body", rec.Code, rec.Body.String())
	}
}

func (f *claimFixture) ticket(t *testing.T, id string) Ticket {
	t.Helper()
	body, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodGet, "/api/tickets/"+id, "", http.StatusOK)
	return decodeAs[Ticket](t, body)
}

func (f *claimFixture) archive(t *testing.T, id string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + id + "/archive", cookie: f.cookie})
}

type roundRow struct {
	publicID, ticketID, state string
	sequence, epoch           int
}

func roundRows(t *testing.T, pool *pgxpool.Pool) []roundRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT r.public_id::text, t.public_id::text, r.state, r.sequence, r.claim_epoch
		FROM rounds r JOIN tickets t ON t.id = r.ticket_id ORDER BY r.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []roundRow
	for rows.Next() {
		var r roundRow
		if err := rows.Scan(&r.publicID, &r.ticketID, &r.state, &r.sequence, &r.epoch); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func (f *claimFixture) deliverThroughAPI(t *testing.T, roundID string) {
	t.Helper()
	var state string
	var epoch int
	if err := f.pool.QueryRow(context.Background(), `SELECT state, claim_epoch FROM rounds WHERE public_id = $1::uuid`, roundID).Scan(&state, &epoch); err != nil {
		t.Fatal(err)
	}
	if state == string(RoundClaimed) {
		f.mustReport(t, roundID, startedEvent(roundID+":start", epoch, eventOccurredAt, eventReference))
	}
	f.mustReport(t, roundID, deliveredEvent(t, roundID+":deliver", epoch, standardDeliverable()))
}

// For Tickets a test moved out of In Progress by SQL, which real delivery refuses.
func closeRoundDirect(t *testing.T, pool *pgxpool.Pool, roundID string) {
	t.Helper()
	tag, err := pool.Exec(context.Background(), `WITH closed AS (
			UPDATE rounds SET state = 'delivered', started_at = COALESCE(started_at, claimed_at), ended_at = COALESCE(started_at, claimed_at)
			 WHERE public_id = $1::uuid RETURNING owner_id, id)
		INSERT INTO round_deliverables (owner_id, round_id, body_markdown, summary, criteria_assessment)
		SELECT owner_id, id, 'Closed by SQL', 'Closed by SQL', 'Closed by SQL' FROM closed`, roundID)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("close round %s: %v (%d rows)", roundID, err, tag.RowsAffected())
	}
}

func waitForLockWaiter(t *testing.T, pool *pgxpool.Pool, query string) {
	t.Helper()
	waitForLockWaiters(t, pool, query, 1)
}

func waitForLockWaiters(t *testing.T, pool *pgxpool.Pool, query string, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%' || $1 || '%'`, query).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("fewer than %d queries like %q blocked on a lock within 5 s", n, query)
}

type ticketRowFacts struct {
	status, assigneeType string
	agentID              *int64
	rank                 int64
	updatedAt            time.Time
}

func readTicketRowFacts(t *testing.T, pool *pgxpool.Pool, id string) ticketRowFacts {
	t.Helper()
	var facts ticketRowFacts
	if err := pool.QueryRow(context.Background(), `SELECT status, assignee_type, assignee_agent_id, priority_rank, updated_at FROM tickets WHERE public_id = $1::uuid`, id).
		Scan(&facts.status, &facts.assigneeType, &facts.agentID, &facts.rank, &facts.updatedAt); err != nil {
		t.Fatal(err)
	}
	return facts
}

func TestClaim_CreatesOneRoundAndLeavesTheTicketReady(t *testing.T) {
	f := newClaimFixture(t)
	queued := f.queue(t, "Investigate the leak")
	before := readTicketRowFacts(t, f.pool, queued.Id)

	claim := f.mustClaim(t)
	if _, err := uuid.Parse(claim.RoundId); err != nil || claim.RoundId == queued.Id {
		t.Fatalf("roundId %q is not a fresh UUID", claim.RoundId)
	}
	want := RunnerClaim{
		RoundId: claim.RoundId, Sequence: 1, ClaimEpoch: 1,
		Ticket: ClaimedTicket{Id: queued.Id, Title: "Investigate the leak", Goal: "Find the cause", Context: "ctx", SuccessCriteria: "A written cause", Constraints: "none"},
		Agent:  TicketAssigneeAgent{Id: f.agent.Id, Name: "Researcher", Kind: AgentKindResearch},
	}
	if claim != want {
		t.Fatalf("claim = %+v, want %+v", claim, want)
	}
	if got := readTicketRowFacts(t, f.pool, queued.Id); got.status != before.status || got.assigneeType != before.assigneeType ||
		*got.agentID != *before.agentID || got.rank != before.rank || !got.updatedAt.Equal(before.updatedAt) {
		t.Fatalf("Ticket row after the claim = %+v, want unchanged %+v", got, before)
	}

	ticket := f.ticket(t, queued.Id)
	wantRound := &TicketOpenRound{Id: claim.RoundId, Sequence: 1, State: OpenRoundClaimed, Agent: want.Agent, ClaimedAt: runnerEpoch}
	if ticket.Status != Ready || ticket.RequestingAgentWork || ticket.OpenRound == nil || *ticket.OpenRound != *wantRound {
		t.Fatalf("claimed Ticket: status=%s requestingAgentWork=%t openRound=%+v, want Ready, false, %+v", ticket.Status, ticket.RequestingAgentWork, ticket.OpenRound, wantRound)
	}
	listed, _, _ := badgeRequest(t, f.handler, f.cookie, http.MethodGet, "/api/tickets", "", http.StatusOK)
	if got := decodeAs[TicketList](t, listed).Tickets[0].OpenRound; got == nil || *got != *wantRound {
		t.Fatalf("listed openRound = %+v, want %+v", got, wantRound)
	}

	if rows := roundRows(t, f.pool); len(rows) != 1 || rows[0] != (roundRow{claim.RoundId, queued.Id, "claimed", 1, 1}) {
		t.Fatalf("rounds = %+v", rows)
	}
}

func TestClaim_ConcurrentClaimsCreateExactlyOneRound(t *testing.T) {
	const claimants = 24
	for trial := range 4 {
		f := newClaimFixture(t)
		first := f.queue(t, "first")
		f.queue(t, "second")
		f.queue(t, "third")

		codes := make([]int, claimants)
		bodies := make([]string, claimants)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := range claimants {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				rec := f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", token: f.token})
				codes[i], bodies[i] = rec.Code, rec.Body.String()
			}()
		}
		close(start)
		wg.Wait()

		created := 0
		var claim RunnerClaim
		for i, code := range codes {
			switch code {
			case http.StatusCreated:
				created++
				if err := json.Unmarshal([]byte(bodies[i]), &claim); err != nil {
					t.Fatal(err)
				}
			case http.StatusNoContent:
			default:
				t.Fatalf("trial %d claimant %d: status=%d body=%s", trial, i, code, bodies[i])
			}
		}
		rows := roundRows(t, f.pool)
		if created != 1 || len(rows) != 1 || rows[0].epoch != 1 || rows[0].sequence != 1 || rows[0].ticketID != first.Id || claim.RoundId != rows[0].publicID || claim.ClaimEpoch != 1 {
			t.Fatalf("trial %d: %d claims admitted, rounds=%+v, claim=%+v; want one Round with epoch 1 on the top Ticket", trial, created, rows, claim)
		}
	}
}

func TestClaim_SecondClaimWhileARoundIsOpenIsNoWork(t *testing.T) {
	f := newClaimFixture(t)
	first := f.queue(t, "first")
	second := f.queue(t, "second")
	claim := f.mustClaim(t)
	assertNoWork(t, f.claim(t))
	assertNoWork(t, f.claim(t))
	if got := f.ticket(t, second.Id); !got.RequestingAgentWork || got.OpenRound != nil || got.Status != Ready {
		t.Fatalf("waiting Ticket = %+v, want still requesting work", got)
	}
	if rows := roundRows(t, f.pool); len(rows) != 1 || rows[0].ticketID != first.Id || rows[0].publicID != claim.RoundId {
		t.Fatalf("rounds = %+v", rows)
	}
}

func TestClaim_FollowsTheOwnerPriorityOrder(t *testing.T) {
	f := newClaimFixture(t)
	a := f.queue(t, "A")
	b := f.queue(t, "B")
	c := f.queue(t, "C")
	badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+c.Id+"/position", fmt.Sprintf(`{"before":%q}`, a.Id), http.StatusOK)

	var claimed []string
	for range 3 {
		claim := f.mustClaim(t)
		claimed = append(claimed, claim.Ticket.Id)
		assertNoWork(t, f.claim(t))
		f.deliverThroughAPI(t, claim.RoundId)
		badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+claim.Ticket.Id+"/archive", "", http.StatusOK)
	}
	if want := []string{c.Id, a.Id, b.Id}; !equalStrings(claimed, want) {
		t.Fatalf("claim order = %v, want C, A, B %v", claimed, want)
	}
	assertNoWork(t, f.claim(t))
}

func TestClaim_SequenceCountsRoundsPerTicket(t *testing.T) {
	f := newClaimFixture(t)
	queued := f.queue(t, "again")
	first := f.mustClaim(t)
	f.deliverThroughAPI(t, first.RoundId)
	badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+queued.Id+"/accept", "", http.StatusOK)
	badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+queued.Id+"/status", `{"status":"Ready"}`, http.StatusOK)
	if got := f.ticket(t, queued.Id); !got.RequestingAgentWork || got.OpenRound != nil {
		t.Fatalf("Ticket after its Round ended = %+v, want requesting work again", got)
	}
	second := f.mustClaim(t)
	if second.Ticket.Id != queued.Id || second.Sequence != 2 || second.ClaimEpoch != first.ClaimEpoch+1 || second.RoundId == first.RoundId {
		t.Fatalf("second claim = %+v, want Round 2 of the same Ticket with the next epoch", second)
	}
}

func TestClaim_SkipsAnIneligibleTopCandidate(t *testing.T) {
	f := newClaimFixture(t)
	top := f.queue(t, "top")
	next := f.queue(t, "next")
	badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+top.Id+"/position", fmt.Sprintf(`{"before":%q}`, next.Id), http.StatusOK)
	// A Ready Agent Ticket made before #128 can lack inputs; the API refuses to clear them now.
	if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET success_criteria = NULL WHERE public_id = $1::uuid`, top.Id); err != nil {
		t.Fatal(err)
	}
	if got := f.ticket(t, top.Id); got.RequestingAgentWork || got.Status != Ready {
		t.Fatalf("incomplete top Ticket = %+v, want Ready and not requesting work", got)
	}
	if claim := f.mustClaim(t); claim.Ticket.Id != next.Id {
		t.Fatalf("claimed %s, want the next eligible Ticket %s", claim.Ticket.Id, next.Id)
	}
	if got := f.ticket(t, top.Id); got.OpenRound != nil {
		t.Fatalf("the ineligible Ticket got a Round: %+v", got.OpenRound)
	}
}

func TestClaim_RechecksTheLockedTicket(t *testing.T) {
	for name, change := range map[string]string{
		"inputs cleared":  `UPDATE tickets SET goal = NULL WHERE public_id = $1::uuid`,
		"archived":        `UPDATE tickets SET archived_at = now() WHERE public_id = $1::uuid`,
		"unassigned":      `UPDATE tickets SET assignee_type = NULL, assignee_agent_id = NULL WHERE public_id = $1::uuid`,
		"moved off Ready": `UPDATE tickets SET status = 'Backlog' WHERE public_id = $1::uuid`,
	} {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			top := f.queue(t, "top")
			next := f.queue(t, "next")
			ctx := context.Background()
			tx, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx) //nolint:errcheck
			if _, err := tx.Exec(ctx, `SELECT 1 FROM tickets WHERE public_id = $1::uuid FOR UPDATE`, top.Id); err != nil {
				t.Fatal(err)
			}
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				result <- f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", token: f.token})
			}()
			waitForLockWaiter(t, f.pool, "FOR UPDATE")
			if _, err := tx.Exec(ctx, change, top.Id); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if claim := decodeClaim(t, <-result); claim.Ticket.Id != next.Id {
				t.Fatalf("claimed %s after the top Ticket was %s under its row lock, want %s", claim.Ticket.Id, name, next.Id)
			}
		})
	}
}

func TestClaim_ArchiveCommittedWhileTheClaimWaitsIsNotClaimed(t *testing.T) {
	f := newClaimFixture(t)
	queued := f.queue(t, "archived first")
	ctx := context.Background()
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := lockOwnerPriority(ctx, tx, resolveTestOwner(t, f.pool)); err != nil {
		t.Fatal(err)
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", token: f.token})
	}()
	waitForLockWaiter(t, f.pool, "pg_advisory_xact_lock")
	if rec := f.archive(t, queued.Id); rec.Code != http.StatusOK {
		t.Fatalf("archive while the claim waits: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assertNoWork(t, <-result)
	if rows := roundRows(t, f.pool); len(rows) != 0 {
		t.Fatalf("rounds = %+v", rows)
	}
}

func TestClaimAndArchive_RaceEitherOrder(t *testing.T) {
	f := newClaimFixture(t)
	outcomes := map[string]int{}
	for trial := 0; trial < 300 && (outcomes["archive won"] < 10 || outcomes["claim won"] < 10); trial++ {
		queued := f.queue(t, fmt.Sprintf("race %d", trial))
		var claimRec, archiveRec *httptest.ResponseRecorder
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; claimRec = f.claim(t) }()
		jitter := time.Duration(rand.IntN(800)) * time.Microsecond
		go func() { defer wg.Done(); <-start; time.Sleep(jitter); archiveRec = f.archive(t, queued.Id) }()
		close(start)
		wg.Wait()

		ticket := f.ticket(t, queued.Id)
		rows := roundRows(t, f.pool)
		switch {
		case claimRec.Code == http.StatusCreated && archiveRec.Code == http.StatusBadRequest:
			assertErrorCode(t, archiveRec, roundOpenCode)
			claim := decodeClaim(t, claimRec)
			if claim.Ticket.Id != queued.Id || ticket.ArchivedAt != nil || ticket.OpenRound == nil || ticket.OpenRound.Id != claim.RoundId {
				t.Fatalf("trial %d: claim won but Ticket = %+v, claim = %+v", trial, ticket, claim)
			}
			outcomes["claim won"]++
			f.deliverThroughAPI(t, claim.RoundId)
			if rec := f.archive(t, queued.Id); rec.Code != http.StatusOK {
				t.Fatalf("archive after the Round ended: status=%d body=%s", rec.Code, rec.Body.String())
			}
		case claimRec.Code == http.StatusNoContent && archiveRec.Code == http.StatusOK:
			if ticket.ArchivedAt == nil || ticket.OpenRound != nil {
				t.Fatalf("trial %d: archive won but Ticket = %+v", trial, ticket)
			}
			for _, row := range rows {
				if row.ticketID == queued.Id {
					t.Fatalf("trial %d: archive won but the Ticket has a Round %+v", trial, row)
				}
			}
			outcomes["archive won"]++
		default:
			t.Fatalf("trial %d: claim %d %s, archive %d %s; want exactly one to win", trial, claimRec.Code, claimRec.Body.String(), archiveRec.Code, archiveRec.Body.String())
		}
	}
	t.Logf("outcomes: %v", outcomes)
	if outcomes["archive won"] == 0 || outcomes["claim won"] == 0 {
		t.Fatalf("only one order was observed: %v", outcomes)
	}
}

func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, code string) ErrorBody {
	t.Helper()
	var body ErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code != code {
		t.Fatalf("body = %s, want error code %s", rec.Body.String(), code)
	}
	return body
}

func TestArchive_RejectedWhileARoundIsOpenAndAllowedWithout(t *testing.T) {
	f := newClaimFixture(t)
	claimedTicket := f.queue(t, "claimed")
	waiting := f.queue(t, "waiting")
	claim := f.mustClaim(t)

	rec := f.archive(t, claimedTicket.Id)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("archive with an open Round: status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := assertErrorCode(t, rec, roundOpenCode)
	if body.Error.Message != roundOpenMessage {
		t.Fatalf("message = %q", body.Error.Message)
	}
	if got := f.ticket(t, claimedTicket.Id); got.ArchivedAt != nil || got.OpenRound == nil || got.Status != Ready {
		t.Fatalf("Ticket after the refused archive = %+v", got)
	}
	if rec := f.archive(t, waiting.Id); rec.Code != http.StatusOK {
		t.Fatalf("archive of a queued Ticket with no Round: status=%d body=%s", rec.Code, rec.Body.String())
	}
	f.deliverThroughAPI(t, claim.RoundId)
	if rec := f.archive(t, claimedTicket.Id); rec.Code != http.StatusOK {
		t.Fatalf("archive after the Round ended: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestClaim_RunnerMustBeConnected(t *testing.T) {
	f := &claimFixture{runnerFixture: newRunnerFixture(t)}
	f.agent = createAgentForTest(t, f.handler, f.cookie, "Researcher", AgentKindResearch)
	queued := f.queue(t, "waits for a runner")
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims"}))

	f.token = f.pair(t).Token
	assertNoWork(t, f.claim(t))

	f.register(t, f.token, http.StatusOK)
	f.clock.Set(runnerEpoch.Add(runnerHealthWindow))
	assertNoWork(t, f.claim(t))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", cookie: f.cookie}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/claims", cookie: f.cookie, token: f.token}))

	if got := f.ticket(t, queued.Id); got.Status != Ready || !got.RequestingAgentWork || got.OpenRound != nil {
		t.Fatalf("Ticket while no runner is connected = %+v", got)
	}
	if rows := roundRows(t, f.pool); len(rows) != 0 {
		t.Fatalf("rounds while no runner is connected = %+v", rows)
	}

	beat := runnerEpoch.Add(time.Minute)
	f.clock.Set(beat)
	f.heartbeat(t, f.token, http.StatusOK)
	if claim := f.mustClaim(t); claim.Ticket.Id != queued.Id {
		t.Fatalf("claim after a heartbeat = %+v", claim)
	}

	f.clock.Set(beat.Add(runnerHealthWindow - time.Second))
	assertNoWork(t, f.claim(t))
	f.clock.Set(beat.Add(runnerHealthWindow))
	if got := f.health(t); got.State != RunnerDisconnected || !got.LastSeenAt.Equal(beat) {
		t.Fatalf("health = %+v, want disconnected at the heartbeat's last-seen: a claim is not a heartbeat", got)
	}

	f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/runner-credential", cookie: f.cookie}, http.StatusNoContent)
	assertUnauthenticated(t, f.claim(t))
}

func TestClaim_ScopedToTheRunnersOwner(t *testing.T) {
	f := newClaimFixture(t)
	mine := f.queue(t, "mine")

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)

	assertNoWork(t, foreign.claim(t))
	if got := f.ticket(t, mine.Id); got.OpenRound != nil || !got.RequestingAgentWork {
		t.Fatalf("another Owner's runner touched this Ticket: %+v", got)
	}

	theirs := foreign.queue(t, "theirs")
	if claim := foreign.mustClaim(t); claim.Ticket.Id != theirs.Id || claim.Agent.Id != foreign.agent.Id {
		t.Fatalf("foreign claim = %+v, want only its own Ticket", claim)
	}
	if claim := f.mustClaim(t); claim.Ticket.Id != mine.Id {
		t.Fatalf("own claim = %+v; another Owner's open Round must not take this Owner's slot", claim)
	}
}

func TestRounds_IdentityIsGalleyIssuedAndHasNoEngineReference(t *testing.T) {
	f := newClaimFixture(t)
	f.queue(t, "identity")
	claim := f.mustClaim(t)
	parsed, err := uuid.Parse(claim.RoundId)
	if err != nil || parsed.Version() != 4 {
		t.Fatalf("roundId %q is not a random UUID issued by Galley", claim.RoundId)
	}
	rows, err := f.pool.Query(context.Background(), `SELECT column_name FROM information_schema.columns WHERE table_name = 'rounds' ORDER BY column_name`)
	if err != nil {
		t.Fatal(err)
	}
	var columns []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, name)
	}
	rows.Close()
	want := []string{"agent_id", "claim_epoch", "claimed_at", "ended_at", "id", "outcome_note", "owner_id", "public_id", "sequence", "started_at", "state", "ticket_id"}
	if !equalStrings(columns, want) {
		t.Fatalf("rounds columns = %v, want %v (an engine execution reference is a separate record, ADR 0002)", columns, want)
	}
}

func TestRounds_DatabaseEnforcesTheSlotAndInvariants(t *testing.T) {
	f := newClaimFixture(t)
	a := f.queue(t, "A")
	b := f.queue(t, "B")
	f.mustClaim(t)
	ctx := context.Background()
	insert := func(ticketID, state, extra string) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at)
			SELECT t.owner_id, gen_random_uuid(), t.id, t.assignee_agent_id, 9, $2, 1, now(), `+extra+`
			  FROM tickets t WHERE t.public_id = $1::uuid`, ticketID, state)
		return err
	}
	for _, tc := range []struct {
		name, ticket, state, extra, constraint string
	}{
		{"second claimed Round for the Owner", b.Id, "claimed", "NULL, NULL", oneOpenRoundPerOwnerIndex},
		{"running beside a claimed Round", b.Id, "running", "now(), NULL", oneOpenRoundPerOwnerIndex},
		{"state outside M5.3", b.Id, "abandoned", "now(), now()", "rounds_state_m5"},
		{"claimed with a start", b.Id, "claimed", "now(), NULL", "rounds_timestamps_follow_state"},
		{"delivered without an end", b.Id, "delivered", "now(), NULL", "rounds_timestamps_follow_state"},
		{"ended before claimed", b.Id, "delivered", "now(), now() - interval '1 hour'", "rounds_timestamps_ordered"},
	} {
		err := insert(tc.ticket, tc.state, tc.extra)
		if err == nil || !strings.Contains(err.Error(), tc.constraint) {
			t.Errorf("%s: err = %v, want a %s violation", tc.name, err, tc.constraint)
		}
	}
	if err := insert(b.Id, "delivered", "now(), now()"); err != nil {
		t.Fatalf("a delivered Round beside the open one: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE rounds SET claim_epoch = 0`); err == nil || !strings.Contains(err.Error(), "rounds_claim_epoch_positive") {
		t.Fatalf("claim epoch 0: err = %v", err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at)
		SELECT t.owner_id, gen_random_uuid(), t.id, t.assignee_agent_id, 1, 'delivered', 1, now(), now(), now() FROM tickets t WHERE t.public_id = $1::uuid`, a.Id); err == nil || !strings.Contains(err.Error(), "rounds_ticket_sequence_unique") {
		t.Fatalf("duplicate sequence for a Ticket: err = %v", err)
	}

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreignAgent := createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	if _, err := f.pool.Exec(ctx, `INSERT INTO rounds (owner_id, public_id, ticket_id, agent_id, sequence, state, claim_epoch, claimed_at, started_at, ended_at)
		SELECT t.owner_id, gen_random_uuid(), t.id, ag.id, 5, 'delivered', 1, now(), now(), now()
		  FROM tickets t, agents ag WHERE t.public_id = $1::uuid AND ag.public_id = $2::uuid`, b.Id, foreignAgent.Id); err == nil || !strings.Contains(err.Error(), "rounds_agent_fk") {
		t.Fatalf("Round with another Owner's Agent: err = %v", err)
	}
}

func TestOpenRoundStates_MatchTheSlotIndexPredicate(t *testing.T) {
	pool := newRunnerFixture(t).pool
	var definition string
	if err := pool.QueryRow(context.Background(), `SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid = $1::regclass`, oneOpenRoundPerOwnerIndex).Scan(&definition); err != nil {
		t.Fatal(err)
	}
	quoted := regexp.MustCompile(`'([a-z_]+)'`)
	states := func(s string) []string {
		var out []string
		for _, m := range quoted.FindAllStringSubmatch(s, -1) {
			out = append(out, m[1])
		}
		sort.Strings(out)
		return out
	}
	if got, want := states(definition), states(openRoundStatesSQL); len(want) == 0 || !equalStrings(got, want) || !strings.Contains(definition, "UNIQUE") || !strings.Contains(definition, "(owner_id)") {
		t.Fatalf("index %s covers %v, Go's open states are %v", definition, got, want)
	}
}
