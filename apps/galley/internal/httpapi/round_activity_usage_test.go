package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/cristoforows/ticketIt/apps/galley/internal/config"
)

const (
	observationA = "0d6b8f1e-2a4c-4e9b-8f3a-5c7d9e1b2a3c"
	observationB = "7e1f2d3c-4b5a-4968-a7b6-c5d4e3f2a1b0"
)

func jsonText(t *testing.T, v any) string {
	t.Helper()
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func progressEvent(t *testing.T, key string, epoch int, occurredAt, note string) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "progress", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": occurredAt, "data": map[string]any{"note": note}})
}

func usageData(id string) map[string]any {
	return map[string]any{
		"observationId": id, "provider": "controlled", "model": "scripted",
		"inputTokens": 1200, "outputTokens": 300, "costUsd": "0.004500", "activeMs": 3000,
		"basis": "reported", "providerGenerationId": nil,
	}
}

func usageWith(id string, changes map[string]any) map[string]any {
	data := usageData(id)
	for key, value := range changes {
		data[key] = value
	}
	return data
}

func usageEvent(t *testing.T, key string, epoch int, data map[string]any) string {
	t.Helper()
	return jsonText(t, map[string]any{"type": "usage_observed", "idempotencyKey": key, "claimEpoch": epoch, "occurredAt": eventOccurredAt, "data": data})
}

func (f *claimFixture) runningRound(t *testing.T, title string) (Ticket, RunnerClaim) {
	t.Helper()
	queued, claim := f.claimTicket(t, title)
	f.startRound(t, claim, claim.RoundId+":0")
	return queued, claim
}

func (f *claimFixture) mustReport(t *testing.T, roundID, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := f.reportEvent(t, roundID, body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("event %s: status=%d body=%s, want 201", body, rec.Code, rec.Body.String())
	}
	return rec
}

func (f *claimFixture) roundOf(t *testing.T, ticketID string) TicketRound {
	t.Helper()
	rounds := decodeRounds(t, f.listRounds(t, ticketID))
	if len(rounds) == 0 {
		t.Fatalf("Ticket %s has no Rounds", ticketID)
	}
	return rounds[0]
}

func roundRowIDs(t *testing.T, f *claimFixture, roundID string) (ownerID, id int64) {
	t.Helper()
	if err := f.pool.QueryRow(context.Background(), `SELECT owner_id, id FROM rounds WHERE public_id = $1::uuid`, roundID).Scan(&ownerID, &id); err != nil {
		t.Fatal(err)
	}
	return ownerID, id
}

func activityRows(t *testing.T, f *claimFixture) map[int]string {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT seq, note FROM round_activity`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int]string{}
	for rows.Next() {
		var seq int
		var note string
		if err := rows.Scan(&seq, &note); err != nil {
			t.Fatal(err)
		}
		out[seq] = note
	}
	return out
}

func wantProgressResult(roundID string, seq int) string {
	return fmt.Sprintf(`{"roundId":%q,"seq":%d,"startedAt":%q,"state":"running","type":"progress"}`, roundID, seq, runnerEpoch.Format(time.RFC3339Nano))
}

func wantUsageResult(roundID, observationID string) string {
	return fmt.Sprintf(`{"observationId":%q,"roundId":%q,"startedAt":%q,"state":"running","type":"usage_observed"}`, observationID, roundID, runnerEpoch.Format(time.RFC3339Nano))
}

func assertViolates(t *testing.T, err error, constraint string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName != constraint {
		t.Fatalf("err = %v, want a %s violation", err, constraint)
	}
}

func TestProgress_AppendsActivityInArrivalOrderAndChangesNoStatus(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Progress")
	ticketBefore := readTicketRowFacts(t, f.pool, queued.Id)
	roundBefore := roundRows(t, f.pool)

	notes := []struct{ key, occurredAt, note string }{
		{claim.RoundId + ":1", "2026-01-02T03:04:07Z", "Reading the Ticket"},
		{claim.RoundId + ":2", "2026-01-02T03:04:06Z", "Working on the goal"},
		{claim.RoundId + ":3", "2026-01-02T11:04:08+08:00", "Writing the result"},
	}
	for i, n := range notes {
		rec := f.mustReport(t, claim.RoundId, progressEvent(t, n.key, 1, n.occurredAt, n.note))
		if got, want := rec.Body.String(), wantProgressResult(claim.RoundId, i+1); got != want {
			t.Fatalf("note %d: body = %s, want %s", i, got, want)
		}
	}

	if after := readTicketRowFacts(t, f.pool, queued.Id); after.status != ticketBefore.status || after.rank != ticketBefore.rank ||
		!after.updatedAt.Equal(ticketBefore.updatedAt) || *after.agentID != *ticketBefore.agentID {
		t.Fatalf("Ticket row changed: %+v -> %+v", ticketBefore, after)
	}
	if after := roundRows(t, f.pool); fmt.Sprint(after) != fmt.Sprint(roundBefore) {
		t.Fatalf("Round rows changed: %+v -> %+v", roundBefore, after)
	}
	if got := f.ticket(t, queued.Id); got.Status != InProgress || got.OpenRound == nil || got.OpenRound.State != RoundRunning {
		t.Fatalf("Ticket = %s %+v, want In Progress and running", got.Status, got.OpenRound)
	}
	round := f.roundOf(t, queued.Id)
	if len(round.Activity) != 3 {
		t.Fatalf("activity = %+v, want 3 notes", round.Activity)
	}
	for i, n := range notes {
		got := round.Activity[i]
		if got.Seq != i+1 || got.Note != n.note || !got.OccurredAt.Equal(mustParseRFC3339(t, n.occurredAt)) || got.OccurredAt.Location() != time.UTC {
			t.Fatalf("activity[%d] = %+v, want seq %d %q at the runner's %s in UTC", i, got, i+1, n.note, n.occurredAt)
		}
	}
	if events := tableRowCount(t, f.pool, "round_events"); events != 4 {
		t.Fatalf("round_events = %d, want the start and three notes", events)
	}
}

func TestProgress_ReplayAppendsNothingAndReturnsTheOriginalResult(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Replay progress")
	body := progressEvent(t, "note-1", 1, eventOccurredAt, "Reading the Ticket")
	first := f.mustReport(t, claim.RoundId, body)
	f.mustReport(t, claim.RoundId, progressEvent(t, "note-2", 1, eventOccurredAt, "Second"))
	afterFirst := databaseSnapshot(t, f.pool)

	f.clock.Set(runnerEpoch.Add(time.Hour))
	for name, replay := range map[string]string{
		"the same bytes":                   body,
		"the same instant in another zone": progressEvent(t, "note-1", 1, "2026-01-02T11:04:05.123456+08:00", "Reading the Ticket"),
		"another layout and escaping":      "{ \"data\": {\"note\": \"Reading the \\u0054icket\"}, \"type\":\"progress\", \"claimEpoch\":1, \"occurredAt\":\"" + eventOccurredAt + "\", \"idempotencyKey\":\"note-1\" }",
	} {
		rec := f.reportEvent(t, claim.RoundId, replay)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
			t.Fatalf("%s: status=%d body=%s, want 200 with the original %s", name, rec.Code, rec.Body.String(), first.Body.String())
		}
		assertSnapshotUnchanged(t, f.pool, afterFirst, "a progress replay of "+name)
	}
	if n := tableRowCount(t, f.pool, "round_activity"); n != 2 {
		t.Fatalf("round_activity = %d rows, want 2", n)
	}

	deliverRoundDirect(t, f.pool, claim.RoundId)
	afterEnd := databaseSnapshot(t, f.pool)
	if rec := f.reportEvent(t, claim.RoundId, body); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay after the Round ended: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterEnd, "a progress replay after the Round ended")
}

func TestUsage_ReplayAppendsNothingAndReturnsTheOriginalResult(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Replay usage")
	body := usageEvent(t, observationA, 1, usageData(observationA))
	first := f.mustReport(t, claim.RoundId, body)
	if got, want := first.Body.String(), wantUsageResult(claim.RoundId, observationA); got != want {
		t.Fatalf("body = %s, want %s", got, want)
	}
	afterFirst := databaseSnapshot(t, f.pool)
	for range 3 {
		rec := f.reportEvent(t, claim.RoundId, body)
		if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
			t.Fatalf("replay: status=%d body=%s, want 200 with the original", rec.Code, rec.Body.String())
		}
	}
	assertSnapshotUnchanged(t, f.pool, afterFirst, "usage replays")
	if n := tableRowCount(t, f.pool, "usage_observations"); n != 1 {
		t.Fatalf("usage_observations = %d rows, want 1", n)
	}

	if _, err := f.pool.Exec(context.Background(), `UPDATE rounds SET claim_epoch = 2`); err != nil {
		t.Fatal(err)
	}
	deliverRoundDirect(t, f.pool, claim.RoundId)
	afterEnd := databaseSnapshot(t, f.pool)
	if rec := f.reportEvent(t, claim.RoundId, body); rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), first.Body.Bytes()) {
		t.Fatalf("replay after the epoch moved and the Round ended: status=%d body=%s", rec.Code, rec.Body.String())
	}
	assertSnapshotUnchanged(t, f.pool, afterEnd, "a usage replay after the Round ended")
}

func TestProgressAndUsage_SameKeyWithADifferentPayloadConflicts(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Conflicts")
	f.mustReport(t, claim.RoundId, progressEvent(t, "note", 1, eventOccurredAt, "Original"))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"another note":                     progressEvent(t, "note", 1, eventOccurredAt, "Changed"),
		"another occurredAt for the note":  progressEvent(t, "note", 1, "2026-01-02T03:04:06Z", "Original"),
		"a usage key reused for progress":  progressEvent(t, observationA, 1, eventOccurredAt, "Original"),
		"a progress key reused for start":  startedEvent("note", 1, eventOccurredAt, eventReference),
		"another cost":                     usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"costUsd": "0.0045"})),
		"an unknown cost instead":          usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"costUsd": nil})),
		"another basis":                    usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"basis": "estimated"})),
		"a provider generation id added":   usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"providerGenerationId": "gen-1"})),
		"another epoch for the same usage": usageEvent(t, observationA, 2, usageData(observationA)),
	} {
		assertErrorBody(t, f.reportEvent(t, claim.RoundId, body), http.StatusConflict, idempotencyKeyConflictCode, idempotencyKeyConflictMessage)
		assertSnapshotUnchanged(t, f.pool, before, name)
	}
}

func TestProgressAndUsage_StaleClaimEpochIsRejectedWithNoChange(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Stale")
	if _, err := f.pool.Exec(context.Background(), `UPDATE rounds SET claim_epoch = 2 WHERE public_id = $1::uuid`, claim.RoundId); err != nil {
		t.Fatal(err)
	}
	before := databaseSnapshot(t, f.pool)
	for _, epoch := range []int{1, 3} {
		for name, body := range map[string]string{
			"progress": progressEvent(t, fmt.Sprintf("note-%d", epoch), epoch, eventOccurredAt, "Stale note"),
			"usage":    usageEvent(t, observationA, epoch, usageData(observationA)),
		} {
			assertErrorBody(t, f.reportEvent(t, claim.RoundId, body), http.StatusConflict, staleClaimEpochCode, staleClaimEpochMessage)
			assertSnapshotUnchanged(t, f.pool, before, fmt.Sprintf("%s at epoch %d", name, epoch))
		}
	}
	f.mustReport(t, claim.RoundId, progressEvent(t, "note-2", 2, eventOccurredAt, "Current note"))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 2, usageData(observationA)))
}

func TestProgressAndUsage_OnAClaimedRoundAreOutOfOrder(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.claimTicket(t, "Not started")
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, progressEvent(t, "note", 1, eventOccurredAt, "Too early")),
		http.StatusConflict, eventOutOfOrderCode, "progress cannot be reported while the Round is claimed")
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, usageEvent(t, observationA, 1, usageData(observationA))),
		http.StatusConflict, eventOutOfOrderCode, "usage_observed cannot be reported while the Round is claimed")
	assertSnapshotUnchanged(t, f.pool, before, "progress and usage on a claimed Round")
	if got := f.ticket(t, queued.Id); got.Status != Ready || got.OpenRound == nil || got.OpenRound.State != RoundClaimed {
		t.Fatalf("Ticket = %s %+v, want Ready and claimed", got.Status, got.OpenRound)
	}
	f.startRound(t, claim, "start")
	f.mustReport(t, claim.RoundId, progressEvent(t, "note", 1, eventOccurredAt, "Too early"))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
}

func TestProgressAndUsage_OnAnEndedRoundAreRejectedWithNoChange(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Ended")
	deliverRoundDirect(t, f.pool, claim.RoundId)
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, progressEvent(t, "note", 1, eventOccurredAt, "Late")), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
	assertErrorBody(t, f.reportEvent(t, claim.RoundId, usageEvent(t, observationA, 1, usageData(observationA))), http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
	assertSnapshotUnchanged(t, f.pool, before, "progress and usage on an ended Round")
}

func TestProgressAndUsage_UnknownAndForeignRoundsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, _ := f.runningRound(t, "Mine")

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	_, theirs := foreign.runningRound(t, "Theirs")

	before := databaseSnapshot(t, f.pool)
	for _, roundID := range []string{uuid.NewString(), theirs.RoundId, queued.Id, "not-a-uuid"} {
		assertRoundNotFound(t, f.reportEvent(t, roundID, progressEvent(t, "note", 1, eventOccurredAt, "Not mine")))
		assertRoundNotFound(t, f.reportEvent(t, roundID, usageEvent(t, observationA, 1, usageData(observationA))))
	}
	assertSnapshotUnchanged(t, f.pool, before, "events for Rounds that are not the runner Owner's")
}

func TestUsage_ObservationsWithoutAProviderIDNeverCollide(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "No provider ids")
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationB, 1, usageData(observationB)))

	rows, err := f.pool.Query(context.Background(), `SELECT u.id::text, r.public_id::text, u.provider_generation_id FROM usage_observations u JOIN rounds r ON r.id = u.round_id ORDER BY u.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id, roundID string
		var generation *string
		if err := rows.Scan(&id, &roundID, &generation); err != nil {
			t.Fatal(err)
		}
		if roundID != claim.RoundId || generation != nil {
			t.Fatalf("observation %s: Round %s generation %v, want Round %s and no provider id", id, roundID, generation, claim.RoundId)
		}
		ids = append(ids, id)
	}
	if want := []string{observationA, observationB}; fmt.Sprint(ids) != fmt.Sprint(want) {
		t.Fatalf("observation ids = %v, want %v", ids, want)
	}
	if usage := f.roundOf(t, queued.Id).Usage; usage.Observations != 2 || usage.CostUsd == nil || *usage.CostUsd != "0.009000" {
		t.Fatalf("usage = %+v, want both observations counted", usage)
	}
}

func TestUsage_TheSameProviderGenerationIDIsKeptTwiceAndNotMerged(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Same generation")
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"providerGenerationId": "gen-1", "costUsd": nil})))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationB, 1, usageWith(observationB, map[string]any{"providerGenerationId": "gen-1", "costUsd": "0.010000"})))
	var count int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM usage_observations WHERE provider_generation_id = 'gen-1'`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("rows for gen-1 = %d (%v), want 2", count, err)
	}
	usage := f.roundOf(t, queued.Id).Usage
	if usage.Observations != 2 || usage.Complete || usage.CostUsd == nil || *usage.CostUsd != "0.010000" {
		t.Fatalf("usage = %+v, want two observations, incomplete, the known 0.010000", usage)
	}
}

func TestUsage_TheKeyIsTheObservationID(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Key and id")
	before := databaseSnapshot(t, f.pool)
	upper := strings.ToUpper(observationA)
	for name, body := range map[string]string{
		"a key other than the observationId": usageEvent(t, claim.RoundId+":5", 1, usageData(observationA)),
		"a key that differs only in case":    usageEvent(t, upper, 1, usageData(observationA)),
		"an uppercase observationId":         usageEvent(t, upper, 1, usageData(upper)),
		"a braced observationId":             usageEvent(t, "{"+observationA+"}", 1, usageData("{"+observationA+"}")),
		"an observationId without hyphens":   usageEvent(t, strings.ReplaceAll(observationA, "-", ""), 1, usageData(strings.ReplaceAll(observationA, "-", ""))),
		"the nil UUID":                       usageEvent(t, uuid.Nil.String(), 1, usageData(uuid.Nil.String())),
		"an observationId that is no UUID":   usageEvent(t, "observation-1", 1, usageData("observation-1")),
	} {
		assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, body))
		assertSnapshotUnchanged(t, f.pool, before, name)
	}
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
	var stored string
	if err := f.pool.QueryRow(context.Background(), `SELECT e.idempotency_key FROM round_events e JOIN usage_observations u ON u.round_id = e.round_id AND u.id::text = e.idempotency_key`).Scan(&stored); err != nil || stored != observationA {
		t.Fatalf("the event key %q (%v) is not the observation's id %s", stored, err, observationA)
	}
}

func TestUsage_AnObservationIDRecordedForAnotherRoundConflicts(t *testing.T) {
	f := newClaimFixture(t)
	_, first := f.runningRound(t, "First")
	f.mustReport(t, first.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
	deliverRoundDirect(t, f.pool, first.RoundId)
	_, second := f.runningRound(t, "Second")
	before := databaseSnapshot(t, f.pool)
	assertErrorBody(t, f.reportEvent(t, second.RoundId, usageEvent(t, observationA, 1, usageData(observationA))), http.StatusConflict, observationIDConflictCode, observationIDConflictMessage)
	assertSnapshotUnchanged(t, f.pool, before, "an observationId reused on another Round")
	f.mustReport(t, second.RoundId, usageEvent(t, observationB, 1, usageData(observationB)))
}

func TestUsage_StrictDecodeRejectsMalformedDataWithNoChange(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Strict usage")
	before := databaseSnapshot(t, f.pool)
	without := func(key string) map[string]any {
		data := usageData(observationA)
		delete(data, key)
		return data
	}
	raw := func(key, literal string) string {
		body := usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{key: "placeholder"}))
		return strings.Replace(body, `"placeholder"`, literal, 1)
	}
	cases := map[string]string{
		"data null":                      strings.Replace(usageEvent(t, observationA, 1, usageData(observationA)), jsonText(t, usageData(observationA)), "null", 1),
		"an unknown data key":            usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"extra": 1})),
		"a wrongly cased data key":       usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"CostUsd": "1"})),
		"progress data":                  usageEvent(t, observationA, 1, map[string]any{"note": "x"}),
		"a missing providerGenerationId": usageEvent(t, observationA, 1, without("providerGenerationId")),
		"a missing costUsd":              usageEvent(t, observationA, 1, without("costUsd")),
		"a missing inputTokens":          usageEvent(t, observationA, 1, without("inputTokens")),
		"a missing basis":                usageEvent(t, observationA, 1, without("basis")),
		"a missing observationId":        usageEvent(t, observationA, 1, without("observationId")),
		"provider empty":                 usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"provider": ""})),
		"provider null":                  raw("provider", "null"),
		"provider too long":              usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"provider": strings.Repeat("p", 201)})),
		"model with a control character": usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"model": "a\x07b"})),
		"model a number":                 raw("model", "5"),
		"basis unknown":                  usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"basis": "guessed"})),
		"basis wrongly cased":            usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"basis": "Reported"})),
		"basis null":                     raw("basis", "null"),
		"inputTokens negative":           raw("inputTokens", "-1"),
		"inputTokens negative zero":      raw("inputTokens", "-0"),
		"inputTokens fractional":         raw("inputTokens", "1.5"),
		"inputTokens with a fraction":    raw("inputTokens", "1.0"),
		"inputTokens exponent":           raw("inputTokens", "1e3"),
		"inputTokens leading zero":       raw("inputTokens", "01"),
		"inputTokens a string":           raw("inputTokens", `"12"`),
		"inputTokens beyond 2^53-1":      raw("inputTokens", "9007199254740992"),
		"outputTokens beyond int64":      raw("outputTokens", "99999999999999999999"),
		"activeMs a boolean":             raw("activeMs", "true"),
		"costUsd a number":               raw("costUsd", "0.0045"),
		"costUsd empty":                  raw("costUsd", `""`),
		"costUsd negative":               raw("costUsd", `"-0.1"`),
		"costUsd with a plus":            raw("costUsd", `"+0.1"`),
		"costUsd seven decimals":         raw("costUsd", `"0.0000001"`),
		"costUsd seven integer digits":   raw("costUsd", `"1000000"`),
		"costUsd exponent":               raw("costUsd", `"1e-3"`),
		"costUsd leading zero":           raw("costUsd", `"01.5"`),
		"costUsd bare point":             raw("costUsd", `".5"`),
		"costUsd trailing point":         raw("costUsd", `"1."`),
		"costUsd with a dollar sign":     raw("costUsd", `"$1"`),
		"costUsd with a space":           raw("costUsd", `" 1"`),
		"providerGenerationId empty":     raw("providerGenerationId", `""`),
		"providerGenerationId too long":  usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"providerGenerationId": strings.Repeat("g", 201)})),
		"providerGenerationId a number":  raw("providerGenerationId", "7"),
	}
	for name, body := range cases {
		assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, body))
		assertSnapshotUnchanged(t, f.pool, before, name)
	}

	for name, data := range map[string]map[string]any{
		"every figure unknown": usageWith(observationA, map[string]any{"inputTokens": nil, "outputTokens": nil, "costUsd": nil, "activeMs": nil}),
		"the bounds":           usageWith(observationB, map[string]any{"inputTokens": 9007199254740991, "outputTokens": 0, "costUsd": "999999.999999", "activeMs": 0, "provider": strings.Repeat("p", 200), "model": strings.Repeat("m", 200), "providerGenerationId": strings.Repeat("g", 200)}),
	} {
		if rec := f.reportEvent(t, claim.RoundId, usageEvent(t, data["observationId"].(string), 1, data)); rec.Code != http.StatusCreated {
			t.Fatalf("%s: status=%d body=%s, want 201", name, rec.Code, rec.Body.String())
		}
	}
}

func TestProgress_NoteLimitsAtTheAPI(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Note limits")
	before := databaseSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"an empty note":             progressEvent(t, "k", 1, eventOccurredAt, ""),
		"a blank note":              progressEvent(t, "k", 1, eventOccurredAt, " \t\n "),
		"a Unicode-blank note":      progressEvent(t, "k", 1, eventOccurredAt, "\u00a0\u2003\u3000"),
		"2001 characters":           progressEvent(t, "k", 1, eventOccurredAt, strings.Repeat("n", 2001)),
		"2001 two-byte characters":  progressEvent(t, "k", 1, eventOccurredAt, strings.Repeat("é", 2001)),
		"a bell":                    progressEvent(t, "k", 1, eventOccurredAt, "ring\x07"),
		"a carriage return":         progressEvent(t, "k", 1, eventOccurredAt, "one\rtwo"),
		"a NUL":                     progressEvent(t, "k", 1, eventOccurredAt, "a\x00b"),
		"a DEL":                     progressEvent(t, "k", 1, eventOccurredAt, "a\x7fb"),
		"a null note":               `{"type":"progress","idempotencyKey":"k","claimEpoch":1,"occurredAt":"` + eventOccurredAt + `","data":{"note":null}}`,
		"a numeric note":            `{"type":"progress","idempotencyKey":"k","claimEpoch":1,"occurredAt":"` + eventOccurredAt + `","data":{"note":5}}`,
		"an extra data key":         `{"type":"progress","idempotencyKey":"k","claimEpoch":1,"occurredAt":"` + eventOccurredAt + `","data":{"note":"x","seq":1}}`,
		"a wrongly cased key":       `{"type":"progress","idempotencyKey":"k","claimEpoch":1,"occurredAt":"` + eventOccurredAt + `","data":{"Note":"x"}}`,
		"start data for a progress": `{"type":"progress","idempotencyKey":"k","claimEpoch":1,"occurredAt":"` + eventOccurredAt + `","data":{"engineReference":"x"}}`,
		"empty data":                `{"type":"progress","idempotencyKey":"k","claimEpoch":1,"occurredAt":"` + eventOccurredAt + `","data":{}}`,
		"data an array":             `{"type":"progress","idempotencyKey":"k","claimEpoch":1,"occurredAt":"` + eventOccurredAt + `","data":["x"]}`,
	} {
		assertInvalidRequest(t, f.reportEvent(t, claim.RoundId, body))
		assertSnapshotUnchanged(t, f.pool, before, name)
	}
	accepted := []string{
		strings.Repeat("n", 2000),
		strings.Repeat("é", 2000),
		strings.Repeat("🍜", 2000),
		"  line one\n\tline two  ",
		"x",
	}
	for i, note := range accepted {
		f.mustReport(t, claim.RoundId, progressEvent(t, fmt.Sprintf("ok-%d", i), 1, eventOccurredAt, note))
	}
	round := f.roundOf(t, queued.Id)
	for i, note := range accepted {
		if round.Activity[i].Note != note {
			t.Fatalf("note %d stored as %q, want it verbatim", i, round.Activity[i].Note)
		}
	}
}

func TestRoundActivity_TheDatabaseEnforcesItsInvariants(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "DB activity")
	f.mustReport(t, claim.RoundId, progressEvent(t, "k", 1, eventOccurredAt, "first"))
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	insert := func(seq int, note string) error {
		_, err := f.pool.Exec(context.Background(), `INSERT INTO round_activity (owner_id, round_id, seq, note, occurred_at) VALUES ($1, $2, $3, $4, now())`, ownerID, roundID, seq, note)
		return err
	}
	assertViolates(t, insert(2, strings.Repeat("n", 2001)), "round_activity_note_length")
	assertViolates(t, insert(2, strings.Repeat("é", 2001)), "round_activity_note_length")
	assertViolates(t, insert(2, ""), "round_activity_note_length")
	assertViolates(t, insert(2, " \t\r\n\f\v"), "round_activity_note_not_blank")
	assertViolates(t, insert(1, "duplicate"), "round_activity_seq_unique")
	assertViolates(t, insert(0, "zero"), "round_activity_seq_positive")
	if err := insert(2, strings.Repeat("é", 2000)); err != nil {
		t.Fatalf("2000 two-byte characters: %v", err)
	}
	_, err := f.pool.Exec(context.Background(), `INSERT INTO round_activity (owner_id, round_id, seq, note, occurred_at) VALUES ($1, $2, 9, 'x', now())`, ownerID+987654, roundID)
	assertViolates(t, err, "round_activity_round_fk")
}

func TestUsageObservations_TheDatabaseEnforcesItsInvariants(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "DB usage")
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	insert := func(column string, value any) error {
		_, err := f.pool.Exec(context.Background(), `INSERT INTO usage_observations (id, owner_id, round_id, provider, model, basis, occurred_at, `+column+`)
			VALUES ($1, $2, $3, 'controlled', 'scripted', 'reported', now(), $4)`, uuid.NewString(), ownerID, roundID, value)
		return err
	}
	assertViolates(t, insert("input_tokens", -1), "usage_observations_input_tokens_range")
	assertViolates(t, insert("output_tokens", int64(1)<<53), "usage_observations_output_tokens_range")
	assertViolates(t, insert("active_ms", -1), "usage_observations_active_ms_range")
	assertViolates(t, insert("cost_usd", "-0.000001"), "usage_observations_cost_usd_non_negative")
	assertViolates(t, insert("provider_generation_id", ""), "usage_observations_provider_generation_id_length")
	if err := insert("cost_usd", "1000000"); err == nil || !strings.Contains(err.Error(), "22003") {
		t.Fatalf("a cost beyond NUMERIC(12,6): err = %v, want a numeric field overflow", err)
	}
	_, err := f.pool.Exec(context.Background(), `INSERT INTO usage_observations (id, owner_id, round_id, provider, model, basis, occurred_at) VALUES ($1, $2, $3, 'controlled', 'scripted', 'guessed', now())`, uuid.NewString(), ownerID, roundID)
	assertViolates(t, err, "usage_observations_basis")
	if err := insert("provider_generation_id", "gen-1"); err != nil {
		t.Fatal(err)
	}
	if err := insert("provider_generation_id", "gen-1"); err != nil {
		t.Fatalf("a second row with the same provider generation id: %v, want it kept", err)
	}
	_, err = f.pool.Exec(context.Background(), `INSERT INTO usage_observations (id, owner_id, round_id, provider, model, basis, occurred_at) VALUES ($1, $2, $3, 'controlled', 'scripted', 'reported', now())`, uuid.NewString(), ownerID+987654, roundID)
	assertViolates(t, err, "usage_observations_round_fk")
}

func TestUsage_NumericPrecisionRoundTrips(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Precision")
	costs := []string{"0.1", "0.2", "999999.999999", "0.000001", "123.45"}
	for i, cost := range costs {
		id := uuid.NewString()
		f.mustReport(t, claim.RoundId, usageEvent(t, id, 1, usageWith(id, map[string]any{"costUsd": cost, "inputTokens": 9007199254740991 - i})))
		var stored string
		if err := f.pool.QueryRow(context.Background(), `SELECT cost_usd::text FROM usage_observations WHERE id = $1::uuid`, id).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if want := padCost(cost); stored != want {
			t.Fatalf("cost %q stored as %q, want %q", cost, stored, want)
		}
	}
	usage := f.roundOf(t, queued.Id).Usage
	if usage.CostUsd == nil || *usage.CostUsd != "1000123.750000" {
		t.Fatalf("sum of %v = %v, want exactly 1000123.750000", costs, usage.CostUsd)
	}
	var stored int64
	if err := f.pool.QueryRow(context.Background(), `SELECT max(input_tokens) FROM usage_observations`).Scan(&stored); err != nil || stored != 9007199254740991 {
		t.Fatalf("max input tokens = %d (%v), want 2^53-1 exactly", stored, err)
	}

	f2 := newClaimFixture(t)
	queued2, claim2 := f2.runningRound(t, "Float trap")
	for _, cost := range []string{"0.1", "0.2"} {
		id := uuid.NewString()
		f2.mustReport(t, claim2.RoundId, usageEvent(t, id, 1, usageWith(id, map[string]any{"costUsd": cost})))
	}
	rec := f2.listRounds(t, queued2.Id)
	if !strings.Contains(rec.Body.String(), `"costUsd":"0.300000"`) {
		t.Fatalf("0.1 + 0.2 on the wire: %s, want the exact decimal string 0.300000", rec.Body.String())
	}
}

func padCost(cost string) string {
	whole, fraction, _ := strings.Cut(cost, ".")
	return whole + "." + fraction + strings.Repeat("0", 6-len(fraction))
}

func TestRoundUsageSummary_UnknownPartialCompleteAndEstimated(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Summary")

	rec := f.listRounds(t, queued.Id)
	unknownFigure := `{"complete":false,"estimated":false,"sum":null}`
	wantUnknown := `"usage":{"activeMs":` + unknownFigure + `,"complete":false,"costUsd":null,"estimated":false,"inputTokens":` + unknownFigure + `,"observations":0,"outputTokens":` + unknownFigure + `}`
	if !strings.Contains(rec.Body.String(), wantUnknown) {
		t.Fatalf("no observations: %s, want %s", rec.Body.String(), wantUnknown)
	}

	intPtr := func(v int) *int { return &v }
	strPtr := func(v string) *string { return &v }
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 1, usageWith(observationA, map[string]any{"costUsd": nil, "inputTokens": 100, "outputTokens": nil, "activeMs": nil, "basis": "estimated"})))
	want := RoundUsage{
		Observations: 1, Complete: false, Estimated: false, CostUsd: nil,
		InputTokens:  UsageCount{Sum: intPtr(100), Complete: true, Estimated: true},
		OutputTokens: UsageCount{},
		ActiveMs:     UsageCount{},
	}
	assertUsage(t, "one estimated observation with an unknown cost", f.roundOf(t, queued.Id).Usage, want)

	f.mustReport(t, claim.RoundId, usageEvent(t, observationB, 1, usageWith(observationB, map[string]any{"costUsd": "0.250000", "inputTokens": 50, "outputTokens": 20, "activeMs": 1500})))
	want = RoundUsage{
		Observations: 2, Complete: false, Estimated: false, CostUsd: strPtr("0.250000"),
		InputTokens:  UsageCount{Sum: intPtr(150), Complete: true, Estimated: true},
		OutputTokens: UsageCount{Sum: intPtr(20), Complete: false, Estimated: false},
		ActiveMs:     UsageCount{Sum: intPtr(1500), Complete: false, Estimated: false},
	}
	assertUsage(t, "a partial picture", f.roundOf(t, queued.Id).Usage, want)

	f2 := newClaimFixture(t)
	queued2, claim2 := f2.runningRound(t, "Complete")
	f2.mustReport(t, claim2.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
	f2.mustReport(t, claim2.RoundId, usageEvent(t, observationB, 1, usageWith(observationB, map[string]any{"costUsd": "0", "inputTokens": 0, "outputTokens": 0, "activeMs": 0})))
	want = RoundUsage{
		Observations: 2, Complete: true, Estimated: false, CostUsd: strPtr("0.004500"),
		InputTokens:  UsageCount{Sum: intPtr(1200), Complete: true},
		OutputTokens: UsageCount{Sum: intPtr(300), Complete: true},
		ActiveMs:     UsageCount{Sum: intPtr(3000), Complete: true},
	}
	assertUsage(t, "every value known and reported", f2.roundOf(t, queued2.Id).Usage, want)

	third := uuid.NewString()
	f2.mustReport(t, claim2.RoundId, usageEvent(t, third, 1, usageWith(third, map[string]any{"basis": "estimated", "costUsd": "0.000500"})))
	want.Observations, want.Estimated, want.CostUsd = 3, true, strPtr("0.005000")
	want.InputTokens = UsageCount{Sum: intPtr(2400), Complete: true, Estimated: true}
	want.OutputTokens = UsageCount{Sum: intPtr(600), Complete: true, Estimated: true}
	want.ActiveMs = UsageCount{Sum: intPtr(6000), Complete: true, Estimated: true}
	assertUsage(t, "a complete picture with an estimate", f2.roundOf(t, queued2.Id).Usage, want)
}

func assertUsage(t *testing.T, name string, got, want RoundUsage) {
	t.Helper()
	if g, w := jsonText(t, got), jsonText(t, want); g != w {
		t.Fatalf("%s: usage = %s, want %s", name, g, w)
	}
}

func TestListTicketRounds_ActivityIsTheLatest50OldestFirst(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Many notes")
	for i := 1; i <= 60; i++ {
		f.mustReport(t, claim.RoundId, progressEvent(t, fmt.Sprintf("note-%d", i), 1, eventOccurredAt, fmt.Sprintf("note %d", i)))
	}
	activity := f.roundOf(t, queued.Id).Activity
	if len(activity) != 50 {
		t.Fatalf("activity has %d notes, want 50", len(activity))
	}
	for i, note := range activity {
		if want := i + 11; note.Seq != want || note.Note != fmt.Sprintf("note %d", want) {
			t.Fatalf("activity[%d] = %+v, want seq %d", i, note, want)
		}
	}
	if n := tableRowCount(t, f.pool, "round_activity"); n != 60 {
		t.Fatalf("round_activity = %d rows, want all 60 kept", n)
	}
}

func TestListTicketRounds_ActivityAndUsageBelongToTheirRoundAndOwner(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.runningRound(t, "Twice")
	f.mustReport(t, first.RoundId, progressEvent(t, "n", 1, eventOccurredAt, "first Round"))
	f.mustReport(t, first.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
	deliverRoundDirect(t, f.pool, first.RoundId)
	if _, err := f.pool.Exec(context.Background(), `UPDATE tickets SET status = 'Ready'`); err != nil {
		t.Fatal(err)
	}
	second := f.mustClaim(t)
	f.startRound(t, second, "start")
	f.mustReport(t, second.RoundId, progressEvent(t, "n", 1, eventOccurredAt, "second Round"))

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirTicket, theirs := foreign.runningRound(t, "Theirs")
	foreign.mustReport(t, theirs.RoundId, progressEvent(t, "n", 1, eventOccurredAt, "their note"))
	foreign.mustReport(t, theirs.RoundId, usageEvent(t, observationB, 1, usageData(observationB)))

	rounds := decodeRounds(t, f.listRounds(t, queued.Id))
	if len(rounds) != 2 || rounds[0].Id != second.RoundId || rounds[1].Id != first.RoundId {
		t.Fatalf("rounds = %+v", rounds)
	}
	if len(rounds[0].Activity) != 1 || rounds[0].Activity[0].Note != "second Round" || rounds[0].Activity[0].Seq != 1 || rounds[0].Usage.Observations != 0 {
		t.Fatalf("second Round = %+v", rounds[0])
	}
	if len(rounds[1].Activity) != 1 || rounds[1].Activity[0].Note != "first Round" || rounds[1].Usage.Observations != 1 {
		t.Fatalf("first Round = %+v", rounds[1])
	}
	assertTicketNotFound(t, f.listRounds(t, theirTicket.Id))
	assertTicketNotFound(t, foreign.listRounds(t, queued.Id))
	if got := decodeRounds(t, foreign.listRounds(t, theirTicket.Id)); len(got) != 1 || len(got[0].Activity) != 1 || got[0].Activity[0].Note != "their note" || got[0].Usage.Observations != 1 {
		t.Fatalf("their rounds = %+v", got)
	}
}

func assertTicketNotFound(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want 404", rec.Code, rec.Body.String())
	}
	assertErrorCode(t, rec, "not_found")
}

func TestListTicketRounds_ActivityAndUsageSurviveANewServer(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Durable")
	f.mustReport(t, claim.RoundId, progressEvent(t, "n1", 1, eventOccurredAt, "kept"))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, 1, usageData(observationA)))
	before := f.listRounds(t, queued.Id).Body.String()

	restarted := NewHandlerWithClock(config.Config{Environment: config.EnvDevelopment, Version: "dev"}, time.Now(), f.pool, testLogger(&bytes.Buffer{}), f.clock.Now)
	req := httptest.NewRequest(http.MethodGet, "/api/tickets/"+queued.Id+"/rounds", nil)
	req.AddCookie(f.cookie)
	rec := httptest.NewRecorder()
	restarted.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != before {
		t.Fatalf("after a new server: status=%d body=%s, want %s", rec.Code, rec.Body.String(), before)
	}
	if !strings.Contains(before, `"note":"kept"`) || !strings.Contains(before, `"observations":1`) {
		t.Fatalf("rounds = %s, want the note and the observation", before)
	}
}

func TestProgress_ConcurrentNotesGetDistinctGapFreeSeq(t *testing.T) {
	const senders = 24
	for trial := range 3 {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Concurrent notes")
		codes, bodies := sendConcurrently(senders, func(i int) *httptest.ResponseRecorder {
			return f.reportEvent(t, claim.RoundId, progressEvent(t, fmt.Sprintf("note-%d", i), 1, eventOccurredAt, fmt.Sprintf("note %d", i)))
		})
		bySeq := map[int]string{}
		for i, code := range codes {
			if code != http.StatusCreated {
				t.Fatalf("trial %d sender %d: status=%d body=%s", trial, i, code, bodies[i])
			}
			var result RoundEventResult
			if err := json.Unmarshal([]byte(bodies[i]), &result); err != nil || result.Seq == nil {
				t.Fatalf("trial %d sender %d: body %s (%v)", trial, i, bodies[i], err)
			}
			if previous, taken := bySeq[*result.Seq]; taken {
				t.Fatalf("trial %d: seq %d answered to %q and %q", trial, *result.Seq, previous, fmt.Sprintf("note %d", i))
			}
			bySeq[*result.Seq] = fmt.Sprintf("note %d", i)
		}
		stored := activityRows(t, f)
		seqs := make([]int, 0, len(stored))
		for seq, note := range stored {
			seqs = append(seqs, seq)
			if bySeq[seq] != note {
				t.Fatalf("trial %d: seq %d stored %q but answered %q", trial, seq, note, bySeq[seq])
			}
		}
		sort.Ints(seqs)
		if len(seqs) != senders || seqs[0] != 1 || seqs[senders-1] != senders {
			t.Fatalf("trial %d: stored seqs %v, want 1 to %d without gaps", trial, seqs, senders)
		}
		activity := f.roundOf(t, queued.Id).Activity
		for i, note := range activity {
			if note.Seq != i+1 || note.Note != bySeq[i+1] {
				t.Fatalf("trial %d: activity[%d] = %+v, want seq %d %q", trial, i, note, i+1, bySeq[i+1])
			}
		}
	}
}

func TestProgressAndUsage_ConcurrentIdenticalEventsApplyExactlyOnce(t *testing.T) {
	const senders = 16
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Concurrent replays")
	for name, body := range map[string]string{
		"progress": progressEvent(t, "same", 1, eventOccurredAt, "only once"),
		"usage":    usageEvent(t, observationA, 1, usageData(observationA)),
	} {
		codes, bodies := sendConcurrently(senders, func(int) *httptest.ResponseRecorder { return f.reportEvent(t, claim.RoundId, body) })
		created := 0
		var original string
		for i, code := range codes {
			if code == http.StatusCreated {
				created++
				original = bodies[i]
			} else if code != http.StatusOK {
				t.Fatalf("%s sender %d: status=%d body=%s", name, i, code, bodies[i])
			}
		}
		for i, code := range codes {
			if code == http.StatusOK && bodies[i] != original {
				t.Fatalf("%s: replay %s differs from %s", name, bodies[i], original)
			}
		}
		if created != 1 {
			t.Fatalf("%s: %d created, want 1", name, created)
		}
	}
	if activity, usage := tableRowCount(t, f.pool, "round_activity"), tableRowCount(t, f.pool, "usage_observations"); activity != 1 || usage != 1 {
		t.Fatalf("%d notes and %d observations, want 1 and 1", activity, usage)
	}
}

func TestProgressAndUsage_RacingTheOwnersCommandsNeitherDeadlocksNorChangesTheTicket(t *testing.T) {
	for trial := range 4 {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Racing notes")
		other := f.queue(t, "Other")
		third := f.queue(t, "Third")
		calls := []func() *httptest.ResponseRecorder{
			func() *httptest.ResponseRecorder { return f.archive(t, queued.Id) },
			func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + third.Id + "/position", body: fmt.Sprintf(`{"before":%q}`, other.Id), cookie: f.cookie})
			},
			func() *httptest.ResponseRecorder { return f.claim(t) },
			func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPost, path: "/api/tickets/" + queued.Id + "/status", body: `{"status":"Backlog"}`, cookie: f.cookie})
			},
			func() *httptest.ResponseRecorder {
				return f.do(t, runnerCall{method: http.MethodPatch, path: "/api/tickets/" + queued.Id, body: `{"title":"renamed"}`, cookie: f.cookie})
			},
		}
		const events = 8
		done := make(chan struct{})
		var codes []int
		var bodies []string
		go func() {
			defer close(done)
			codes, bodies = sendConcurrently(events+len(calls), func(i int) *httptest.ResponseRecorder {
				switch {
				case i < events/2:
					return f.reportEvent(t, claim.RoundId, progressEvent(t, fmt.Sprintf("n%d", i), 1, eventOccurredAt, "racing"))
				case i < events:
					id := uuid.NewString()
					return f.reportEvent(t, claim.RoundId, usageEvent(t, id, 1, usageData(id)))
				}
				return calls[i-events]()
			})
		}()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Fatalf("trial %d: the racing requests did not finish within 20 s (deadlock)", trial)
		}
		for i := range events {
			if codes[i] != http.StatusCreated {
				t.Fatalf("trial %d event %d: status=%d body=%s", trial, i, codes[i], bodies[i])
			}
		}
		for i := events; i < len(codes); i++ {
			if codes[i] >= 500 {
				t.Fatalf("trial %d call %d: status=%d body=%s", trial, i, codes[i], bodies[i])
			}
		}
		got := f.ticket(t, queued.Id)
		if got.Status != InProgress || got.ArchivedAt != nil || got.Title != "Racing notes" || got.OpenRound == nil || got.OpenRound.Id != claim.RoundId {
			t.Fatalf("trial %d: Ticket = %s %+v archived=%v title=%q", trial, got.Status, got.OpenRound, got.ArchivedAt, got.Title)
		}
		if activity, usage := tableRowCount(t, f.pool, "round_activity"), tableRowCount(t, f.pool, "usage_observations"); activity != events/2 || usage != events/2 {
			t.Fatalf("trial %d: %d notes and %d observations, want %d each", trial, activity, usage, events/2)
		}
	}
}

func TestProgressAndUsage_OwnerRoutesWriteNoActivityOrUsage(t *testing.T) {
	f := newClaimFixture(t)
	_, claim := f.runningRound(t, "Owner cannot report")
	before := databaseSnapshot(t, f.pool)
	for _, body := range []string{progressEvent(t, "n", 1, eventOccurredAt, "from a session"), usageEvent(t, observationA, 1, usageData(observationA))} {
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/rounds/" + claim.RoundId + "/events", body: body, cookie: f.cookie}))
		assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/rounds/" + claim.RoundId + "/events", body: body}))
	}
	assertSnapshotUnchanged(t, f.pool, before, "events without a runner credential")
}
