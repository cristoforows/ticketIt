package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func attestPath(ticketID, roundID string) string {
	return "/api/tickets/" + ticketID + "/rounds/" + roundID + "/attest-cessation"
}

func attestBody(basis AttestationBasis, note string) string {
	if note == "" {
		return fmt.Sprintf(`{"basis":%q}`, basis)
	}
	return fmt.Sprintf(`{"basis":%q,"note":%q}`, basis, note)
}

func (f *claimFixture) attest(t *testing.T, ticketID, roundID, body string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: attestPath(ticketID, roundID), body: body, cookie: f.cookie})
}

func decodeAttested(t *testing.T, rec *httptest.ResponseRecorder) TicketRound {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("attest: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	var round TicketRound
	if err := json.Unmarshal(rec.Body.Bytes(), &round); err != nil {
		t.Fatal(err)
	}
	return round
}

func (f *claimFixture) mustAttest(t *testing.T, ticketID, roundID string) TicketRound {
	t.Helper()
	return decodeAttested(t, f.attest(t, ticketID, roundID, attestBody(AttestationRunnerProcessEnded, "")))
}

func TestDecideCessationAttestation(t *testing.T) {
	unknown, running, stopped := HeldUnknown, HeldRunning, HeldStopped
	open := func(health RoundHolderHealth, recorded *HeldExecution) cessationFacts {
		return cessationFacts{roundOpen: true, holderHealth: health, recordedExecution: recorded}
	}
	for _, tc := range []struct {
		name    string
		facts   cessationFacts
		message string
	}{
		{"connected, never reconciled", open(HolderConnected, nil), attestationHolderStillReported},
		{"connected, running", open(HolderConnected, &running), attestationHolderStillReported},
		{"connected, stopped", open(HolderConnected, &stopped), attestationHolderStillReported},
		{"connected, unknown", open(HolderConnected, &unknown), ""},
		{"disconnected", open(HolderDisconnected, nil), ""},
		{"disconnected, running", open(HolderDisconnected, &running), ""},
		{"replaced", open(HolderReplaced, &running), ""},
		{"not paired", open(HolderNotPaired, nil), ""},
		{"no open Round", cessationFacts{holderHealth: HolderDisconnected}, attestationNeedsOpenRound},
		{"archived", cessationFacts{archived: true, roundOpen: true, holderHealth: HolderDisconnected}, attestationArchivedTicket},
		{"archived outranks a closed Round", cessationFacts{archived: true}, attestationArchivedTicket},
	} {
		got := decideCessationAttestation(tc.facts)
		switch {
		case tc.message == "" && got != nil:
			t.Errorf("%s: refused with %+v", tc.name, got)
		case tc.message != "" && (got == nil || got.code != attestationNotAvailableCode || got.message != tc.message):
			t.Errorf("%s: %+v, want %s %q", tc.name, got, attestationNotAvailableCode, tc.message)
		}
	}
}

// The advertised availability is the command's answer, case by case.
func TestAttestCessation_AllowedActionsMatchTheCommandInEveryState(t *testing.T) {
	type setup func(t *testing.T, f *claimFixture) (Ticket, string)
	cases := map[string]setup{
		"claimed, connected": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.claimTicket(t, "c")
			return queued, claim.RoundId
		},
		"running, connected": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "r")
			return queued, claim.RoundId
		},
		"running, Stop requested, connected": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim, _ := f.stoppedRound(t, "s", true)
			return queued, claim.RoundId
		},
		"running, reconciled running": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "rr")
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
			return queued, claim.RoundId
		},
		"running, reconciled stopped": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "rs")
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldStopped)))
			return queued, claim.RoundId
		},
		"running, reconciled unknown": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "ru")
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
			return queued, claim.RoundId
		},
		"restarted, held nothing": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "restart")
			f.register(t, f.token, http.StatusOK)
			f.mustReconcile(t, reconcileBody(t))
			return queued, claim.RoundId
		},
		"running, disconnected": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "d")
			f.lapse()
			return queued, claim.RoundId
		},
		"claimed, disconnected": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.claimTicket(t, "cd")
			f.lapse()
			return queued, claim.RoundId
		},
		"waiting for input, disconnected": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.waitingRound(t, "w")
			f.lapse()
			return queued, claim.RoundId
		},
		"waiting for input, connected": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.waitingRound(t, "wc")
			return queued, claim.RoundId
		},
		"replaced": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "rep")
			f.token = f.repair(t)
			return queued, claim.RoundId
		},
		"not paired": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.runningRound(t, "np")
			f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/runner-credential", cookie: f.cookie}, http.StatusNoContent)
			return queued, claim.RoundId
		},
		"delivered": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.deliveredTicket(t, "del")
			f.lapse()
			return queued, claim.RoundId
		},
		"archived after it ended": func(t *testing.T, f *claimFixture) (Ticket, string) {
			queued, claim := f.deliveredTicket(t, "arch")
			badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+queued.Id+"/archive", "", http.StatusOK)
			f.lapse()
			return queued, claim.RoundId
		},
	}
	want := map[string]bool{
		"claimed, connected": false, "running, connected": false, "running, Stop requested, connected": false,
		"running, reconciled running": false, "running, reconciled stopped": false, "running, reconciled unknown": true,
		"restarted, held nothing": true, "running, disconnected": true, "claimed, disconnected": true,
		"waiting for input, disconnected": true, "waiting for input, connected": false, "replaced": true, "not paired": true,
		"delivered": false, "archived after it ended": false,
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, roundID := build(t, f)
			advertised := f.ticket(t, queued.Id).AllowedActions.AttestCessation
			if advertised.Available != want[name] {
				t.Fatalf("attestCessation = %+v, want available=%t", advertised, want[name])
			}
			before := strandedSnapshot(t, f.pool)
			rec := f.attest(t, queued.Id, roundID, attestBody(AttestationRunnerHostOff, ""))
			if advertised.Available {
				if got := decodeAttested(t, rec); got.State != RoundInterrupted {
					t.Fatalf("attested Round = %+v", got)
				}
				return
			}
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s, want 400", rec.Code, rec.Body.String())
			}
			var body ErrorBody
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if advertised.Reason == nil || body.Error != *advertised.Reason {
				t.Fatalf("command error = %+v, advertised reason = %+v; want equal", body.Error, advertised.Reason)
			}
			assertStrandedSnapshotUnchanged(t, f.pool, before, "a refused attestation")
		})
	}
}

func TestAttestCessation_EndsTheRoundInterruptedBlocksTheTicketFreesTheSlotAndKeepsTheRecord(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim, stop := f.stoppedRound(t, "Stranded", true)
	f.mustReport(t, claim.RoundId, progressEvent(t, "p1", claim.ClaimEpoch, eventOccurredAt, "step one"))
	f.mustReport(t, claim.RoundId, usageEvent(t, observationA, claim.ClaimEpoch, usageData(observationA)))
	f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning)))
	next := f.queue(t, "Next")
	lastSeen := f.clock.Now()
	attestedAt := lastSeen.Add(runnerHealthWindow + 5*time.Second)
	f.clock.Set(attestedAt)
	beforeRound := f.roundOf(t, queued.Id)
	if ticket := f.ticket(t, queued.Id); ticket.OpenRound.WaitingReason != WaitingRunnerDisconnected || !ticket.AllowedActions.AttestCessation.Available {
		t.Fatalf("openRound = %+v attest = %+v", ticket.OpenRound, ticket.AllowedActions.AttestCessation)
	}

	rec := f.attest(t, queued.Id, claim.RoundId, attestBody(AttestationOther, "Pulled the plug\n\ton the host."))
	got := decodeAttested(t, rec)
	note := "Pulled the plug\n\ton the host."
	running := HeldRunning
	wantAttestation := RoundAttestation{AttestedAt: attestedAt, Basis: AttestationOther, Note: &note, RoundState: OpenRoundRunning, ClaimEpoch: claim.ClaimEpoch,
		HolderLastSeenAt: &lastSeen, HolderHealth: HolderDisconnected, ReconcileExecution: &running}
	if got.Id != claim.RoundId || got.State != RoundInterrupted || got.EndedAt == nil || !got.EndedAt.Equal(attestedAt) ||
		got.OutcomeNote == nil || *got.OutcomeNote != "Ended by Owner attestation: other." || got.Attestation == nil {
		t.Fatalf("attested Round = %+v", got)
	}
	if a := *got.Attestation; !a.AttestedAt.Equal(wantAttestation.AttestedAt) || a.Basis != wantAttestation.Basis || *a.Note != note || a.RoundState != OpenRoundRunning ||
		a.ClaimEpoch != claim.ClaimEpoch || a.HolderLastSeenAt == nil || !a.HolderLastSeenAt.Equal(lastSeen) || a.HolderHealth != HolderDisconnected ||
		a.ReconcileExecution == nil || *a.ReconcileExecution != HeldRunning {
		t.Fatalf("attestation = %+v, want %+v", a, wantAttestation)
	}
	if jsonText(t, got.Usage) != jsonText(t, beforeRound.Usage) || len(got.Activity) != len(beforeRound.Activity)+1 {
		t.Fatalf("usage %+v activity %d, want usage kept and one note added to %d", got.Usage, len(got.Activity), len(beforeRound.Activity))
	}
	for i, n := range beforeRound.Activity {
		if got.Activity[i] != n {
			t.Fatalf("activity %d = %+v, want kept %+v", i, got.Activity[i], n)
		}
	}
	if last := got.Activity[len(got.Activity)-1]; last.Note != "Ended by Owner attestation: other." || !last.OccurredAt.Equal(attestedAt) {
		t.Fatalf("last note = %+v", last)
	}
	listed := f.roundOf(t, queued.Id)
	if listed.Attestation == nil || listed.OutcomeNote == nil || *listed.OutcomeNote != *got.OutcomeNote {
		t.Fatalf("listed Round = %+v, want the attestation", listed)
	}

	ticket := f.ticket(t, queued.Id)
	if ticket.Status != Blocked || ticket.OpenRound != nil || !containsStatus(ticket.AllowedActions.StatusChanges, Ready) || ticket.AllowedActions.AttestCessation.Available {
		t.Fatalf("Ticket = %s %+v %+v, want Blocked, unlocked, Ready offered", ticket.Status, ticket.OpenRound, ticket.AllowedActions)
	}
	for _, b := range ticket.Badges {
		if b.Name == stoppedBadgeName {
			t.Fatal("an attested Round got the Stopped Badge")
		}
	}
	rows := roundCommandRows(t, f)
	if len(rows) != 1 || rows[0].commandID != stop.Id || rows[0].acknowledgedAt != nil {
		t.Fatalf("commands = %+v, want the Stop kept unacknowledged", rows)
	}
	if commands := f.mustCommands(t, claim.RoundId); len(commands) != 0 {
		t.Fatalf("commands pulled after the attestation = %+v, want none", commands)
	}

	f.heartbeat(t, f.token, http.StatusOK)
	if c := f.mustClaim(t); c.Ticket.Id != next.Id {
		t.Fatalf("claim after the attestation = %+v, want the next Ticket: the slot is free", c)
	}
}

func TestAttestCessation_AClaimedRoundAndAWaitingRoundEndBlocked(t *testing.T) {
	for name, build := range map[string]func(f *claimFixture) (Ticket, RunnerClaim){
		"claimed": func(f *claimFixture) (Ticket, RunnerClaim) { return f.claimTicket(t, "claimed") },
		"waiting": func(f *claimFixture) (Ticket, RunnerClaim) { return f.waitingRound(t, "waiting") },
	} {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := build(f)
			f.lapse()
			got := f.mustAttest(t, queued.Id, claim.RoundId)
			if got.State != RoundInterrupted || *got.OutcomeNote != "Ended by Owner attestation: the Michelin process was ended." {
				t.Fatalf("Round = %+v", got)
			}
			if name == "claimed" && (got.StartedAt != nil || got.Attestation.RoundState != OpenRoundClaimed) {
				t.Fatalf("claimed Round = %+v", got)
			}
			if ticket := f.ticket(t, queued.Id); ticket.Status != Blocked || ticket.OpenRound != nil {
				t.Fatalf("Ticket = %s %+v", ticket.Status, ticket.OpenRound)
			}
		})
	}
}

func TestAttestCessation_ARepeatReturnsTheStoredResultAndChangesNothing(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Twice")
	f.lapse()
	first := f.attest(t, queued.Id, claim.RoundId, attestBody(AttestationRunnerHostOff, ""))
	decodeAttested(t, first)
	before := strandedSnapshot(t, f.pool)
	f.clock.Set(f.clock.Now().Add(time.Hour))
	for _, body := range []string{attestBody(AttestationRunnerHostOff, ""), attestBody(AttestationOther, "changed my mind")} {
		again := f.attest(t, queued.Id, claim.RoundId, body)
		if again.Code != http.StatusOK || again.Body.String() != first.Body.String() {
			t.Fatalf("repeat: status=%d body=%s, want 200 %s", again.Code, again.Body.String(), first.Body.String())
		}
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "a repeated attestation")
}

func TestAttestCessation_BadBodiesAre400BeforeTheLookup(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Bodies")
	f.lapse()
	before := strandedSnapshot(t, f.pool)
	for name, body := range map[string]string{
		"no body":             "",
		"empty object":        `{}`,
		"unknown basis":       `{"basis":"timeout"}`,
		"other without note":  `{"basis":"other"}`,
		"null note":           `{"basis":"other","note":null}`,
		"empty note":          `{"basis":"runner_host_off","note":""}`,
		"blank note":          `{"basis":"other","note":" \n\t "}`,
		"note over 1000":      fmt.Sprintf(`{"basis":"other","note":%q}`, strings.Repeat("界", attestationNoteMaxLength+1)),
		"control in the note": `{"basis":"other","note":"a\u0007b"}`,
		"extra field":         `{"basis":"runner_host_off","x":1}`,
		"array":               `[]`,
	} {
		t.Run(name, func(t *testing.T) {
			assertInvalidRequest(t, f.attest(t, queued.Id, claim.RoundId, body))
			assertInvalidRequest(t, f.attest(t, uuid.NewString(), uuid.NewString(), body))
		})
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "refused attestation bodies")
	got := decodeAttested(t, f.attest(t, queued.Id, claim.RoundId, attestBody(AttestationOther, strings.Repeat("界", attestationNoteMaxLength))))
	if got.Attestation == nil || got.Attestation.Note == nil {
		t.Fatalf("Round = %+v", got)
	}
}

func TestAttestCessation_UnknownForeignAndMismatchedIdsAreTheSharedNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Mine")
	other := f.queue(t, "Other")
	f.lapse()
	foreignCookie, _ := secondOwnerSession(t, f.pool)
	before := strandedSnapshot(t, f.pool)
	body := attestBody(AttestationRunnerHostOff, "")
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"unknown Round":          f.attest(t, queued.Id, uuid.NewString(), body),
		"unknown Ticket":         f.attest(t, uuid.NewString(), claim.RoundId, body),
		"another Ticket's Round": f.attest(t, other.Id, claim.RoundId, body),
		"malformed Ticket":       f.attest(t, "not-a-uuid", claim.RoundId, body),
		"malformed Round":        f.attest(t, queued.Id, "nope", body),
		"another Owner":          f.do(t, runnerCall{method: http.MethodPost, path: attestPath(queued.Id, claim.RoundId), body: body, cookie: foreignCookie}),
	} {
		t.Run(name, func(t *testing.T) { assertRoundNotFound(t, rec) })
	}
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: attestPath(queued.Id, claim.RoundId), body: body}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodPost, path: attestPath(queued.Id, claim.RoundId), body: body, token: f.token}))
	assertStrandedSnapshotUnchanged(t, f.pool, before, "attestations of unknown or foreign Rounds")
}

func TestAttestCessation_LateReportsAreRoundNotOpenAndChangeNothing(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Still alive")
	f.lapse()
	f.mustAttest(t, queued.Id, claim.RoundId)
	before := strandedSnapshot(t, f.pool)
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"progress":    f.reportEvent(t, claim.RoundId, progressEvent(t, "late-p", claim.ClaimEpoch, eventOccurredAt, "still going")),
		"delivered":   f.reportEvent(t, claim.RoundId, deliveredEvent(t, "late-d", claim.ClaimEpoch, standardDeliverable())),
		"interrupted": f.reportEvent(t, claim.RoundId, blockedEndings[1].event(t, "late-i", claim.ClaimEpoch, interruptedEvidence)),
		"reconcile":   f.reconcile(t, reconcileBody(t, heldRound(claim, HeldRunning))),
		"check":       f.check(t, claim.RoundId, claim.ClaimEpoch, writeReport),
	} {
		t.Run(name, func(t *testing.T) {
			assertErrorBody(t, rec, http.StatusConflict, roundNotOpenCode, roundNotOpenMessage)
		})
	}
	if got := f.mustReconcile(t, reconcileBody(t)); got.Round != nil {
		t.Fatalf("held nothing after the attestation = %+v, want round null", got.Round)
	}
	assertStrandedSnapshotUnchanged(t, f.pool, before, "late reports")
}

func TestAttestCessation_ThenReadyCreatesANewRoundWithANewEpoch(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Again")
	f.lapse()
	f.mustAttest(t, queued.Id, claim.RoundId)
	attested := roundSnapshot(t, f.pool, claim.RoundId)
	badgeRequest(t, f.handler, f.cookie, http.MethodPost, "/api/tickets/"+queued.Id+"/status", `{"status":"Ready"}`, http.StatusOK)
	f.heartbeat(t, f.token, http.StatusOK)
	next := f.mustClaim(t)
	if next.Ticket.Id != queued.Id || next.Sequence != 2 || next.ClaimEpoch != claim.ClaimEpoch+1 || next.RoundId == claim.RoundId {
		t.Fatalf("next claim = %+v", next)
	}
	f.startRound(t, next, "start-2")
	if got := roundSnapshot(t, f.pool, claim.RoundId); got != attested {
		t.Fatalf("the attested Round changed:\n%s\n%s", attested, got)
	}
	if ticket := f.ticket(t, queued.Id); ticket.OpenRound == nil || ticket.OpenRound.Id != next.RoundId || ticket.OpenRound.WaitingReason != WaitingWorking {
		t.Fatalf("openRound = %+v", ticket.OpenRound)
	}
}

func TestAttestCessation_RecordsWhatGalleyObservedForEachHolder(t *testing.T) {
	for name, tc := range map[string]struct {
		lose    func(t *testing.T, f *claimFixture, claim RunnerClaim)
		health  RoundHolderHealth
		seen    bool
		belief  *HeldExecution
		connect bool
	}{
		"connected but unknown": {func(t *testing.T, f *claimFixture, claim RunnerClaim) {
			f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
		}, HolderConnected, true, ptrTo(HeldUnknown), true},
		"replaced": {func(t *testing.T, f *claimFixture, claim RunnerClaim) { f.token = f.repair(t) }, HolderReplaced, false, nil, true},
		"not paired": {func(t *testing.T, f *claimFixture, claim RunnerClaim) {
			f.expect(t, runnerCall{method: http.MethodDelete, path: "/api/runner-credential", cookie: f.cookie}, http.StatusNoContent)
		}, HolderNotPaired, false, nil, false},
	} {
		t.Run(name, func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, name)
			tc.lose(t, f, claim)
			a := f.mustAttest(t, queued.Id, claim.RoundId).Attestation
			if a.HolderHealth != tc.health || (a.HolderLastSeenAt != nil) != tc.seen || (a.ReconcileExecution == nil) != (tc.belief == nil) ||
				(tc.belief != nil && *a.ReconcileExecution != *tc.belief) {
				t.Fatalf("attestation = %+v", a)
			}
			var holder *int64
			if err := f.pool.QueryRow(context.Background(), `SELECT holder_runner_id FROM round_attestations`).Scan(&holder); err != nil || holder == nil {
				t.Fatalf("holder_runner_id = %v (%v), want the claiming runner", holder, err)
			}
		})
	}
}

func ptrTo[T any](v T) *T { return &v }

func TestAttestCessation_TheDatabaseEnforcesTheRecord(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "DB")
	f.lapse()
	f.mustAttest(t, queued.Id, claim.RoundId)
	ownerID, roundID := roundRowIDs(t, f, claim.RoundId)
	ctx := context.Background()
	insert := func(basis, note, state, health, execution string) error {
		_, err := f.pool.Exec(ctx, `INSERT INTO round_attestations (owner_id, round_id, attested_at, basis, note, round_state, claim_epoch, holder_health, reconcile_execution)
			VALUES ($1, $2, now(), `+basis+`, `+note+`, `+state+`, 1, `+health+`, `+execution+`)`, ownerID, roundID)
		return err
	}
	assertViolates(t, insert("'runner_host_off'", "NULL", "'running'", "'disconnected'", "NULL"), "round_attestations_round_id_key")
	if _, err := f.pool.Exec(ctx, `DELETE FROM round_attestations`); err != nil {
		t.Fatal(err)
	}
	assertViolates(t, insert("'timeout'", "NULL", "'running'", "'disconnected'", "NULL"), "round_attestations_basis")
	assertViolates(t, insert("'other'", "NULL", "'running'", "'disconnected'", "NULL"), "round_attestations_other_needs_note")
	assertViolates(t, insert("'other'", "''", "'running'", "'disconnected'", "NULL"), "round_attestations_note_length")
	assertViolates(t, insert("'other'", "repeat('n', 1001)", "'running'", "'disconnected'", "NULL"), "round_attestations_note_length")
	assertViolates(t, insert("'other'", "'n'", "'delivered'", "'disconnected'", "NULL"), "round_attestations_round_state")
	assertViolates(t, insert("'other'", "'n'", "'running'", "'gone'", "NULL"), "round_attestations_holder_health")
	assertViolates(t, insert("'other'", "'n'", "'running'", "'replaced'", "'maybe'"), "round_attestations_reconcile_execution")
	if _, err := f.pool.Exec(ctx, `INSERT INTO round_attestations (owner_id, round_id, attested_at, basis, round_state, claim_epoch, holder_health)
		VALUES ($1, 999999, now(), 'runner_host_off', 'running', 1, 'replaced')`, ownerID); err == nil || !strings.Contains(err.Error(), "round_attestations_round_fk") {
		t.Fatalf("an attestation of no Round: err = %v", err)
	}
}

type attestRace struct {
	attest, event *httptest.ResponseRecorder
}

func (f *claimFixture) judgeAttestRace(t *testing.T, queued Ticket, claim RunnerClaim, race attestRace) string {
	t.Helper()
	var attestations int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*) FROM round_attestations a JOIN rounds r ON r.id = a.round_id WHERE r.public_id = $1::uuid`, claim.RoundId).Scan(&attestations); err != nil {
		t.Fatal(err)
	}
	round := f.roundOf(t, queued.Id)
	switch {
	case race.attest.Code == http.StatusOK && race.event.Code == http.StatusConflict:
		assertErrorCode(t, race.event, roundNotOpenCode)
		if attestations != 1 || round.State != RoundInterrupted || round.Attestation == nil {
			t.Fatalf("attestation won but Round = %+v (%d attestations)", round, attestations)
		}
		return "attestation"
	case race.attest.Code == http.StatusBadRequest && race.event.Code == http.StatusCreated:
		assertErrorCode(t, race.attest, attestationNotAvailableCode)
		if attestations != 0 || round.Attestation != nil || round.State == RoundRunning {
			t.Fatalf("the event won but Round = %+v (%d attestations)", round, attestations)
		}
		return "event"
	}
	t.Fatalf("attest %d %s, event %d %s; want exactly one winner", race.attest.Code, race.attest.Body.String(), race.event.Code, race.event.Body.String())
	return ""
}

func (f *claimFixture) raceEnding(t *testing.T, i int, claim RunnerClaim) string {
	if i%2 == 1 {
		return blockedEndings[1].event(t, "end", claim.ClaimEpoch, interruptedEvidence)
	}
	return deliveredEvent(t, "end", claim.ClaimEpoch, standardDeliverable())
}

// Both requests queue on the Owner's priority lock, held here, which grants them in arrival order.
func TestAttestCessation_WhicheverReachesTheLadderFirstWins(t *testing.T) {
	for i, first := range []string{"attestation", "event", "attestation", "event"} {
		t.Run(fmt.Sprintf("%s first, ending %d", first, i%2), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, "ordered")
			f.lapse()
			ownerID, _ := roundRowIDs(t, f, claim.RoundId)
			ending := f.raceEnding(t, i, claim)
			ctx := context.Background()
			holder, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = holder.Rollback(ctx) }()
			if err := lockOwnerPriority(ctx, holder, ownerID); err != nil {
				t.Fatal(err)
			}
			var race attestRace
			var wg sync.WaitGroup
			attest := func() {
				defer wg.Done()
				race.attest = f.attest(t, queued.Id, claim.RoundId, attestBody(AttestationRunnerHostOff, ""))
			}
			event := func() { defer wg.Done(); race.event = f.reportEvent(t, claim.RoundId, ending) }
			order := []func(){attest, event}
			if first == "event" {
				order = []func(){event, attest}
			}
			for n, run := range order {
				wg.Add(1)
				go run()
				waitForLockWaiters(t, f.pool, "pg_advisory_xact_lock", n+1)
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			wg.Wait()
			if won := f.judgeAttestRace(t, queued, claim, race); won != first {
				t.Fatalf("%s won, want %s", won, first)
			}
		})
	}
}

func TestAttestCessation_RacingARunnerEventLeavesExactlyOneWinner(t *testing.T) {
	f := newClaimFixture(t)
	outcomes := map[string]int{}
	for trial := range 40 {
		queued, claim := f.runningRound(t, fmt.Sprintf("race %d", trial))
		f.lapse()
		ending := f.raceEnding(t, trial, claim)
		var race attestRace
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			race.attest = f.attest(t, queued.Id, claim.RoundId, attestBody(AttestationRunnerHostOff, ""))
		}()
		go func() { defer wg.Done(); <-start; race.event = f.reportEvent(t, claim.RoundId, ending) }()
		close(start)
		wg.Wait()
		outcomes[f.judgeAttestRace(t, queued, claim, race)]++
		f.heartbeat(t, f.token, http.StatusOK)
	}
	t.Logf("winners: %v", outcomes)
}

func TestAttestCessation_ConcurrentAttestationsRecordOne(t *testing.T) {
	const attesters = 8
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Many")
	f.lapse()
	recs := make([]*httptest.ResponseRecorder, attesters)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range attesters {
		wg.Add(1)
		basis := AttestationRunnerHostOff
		if i%2 == 0 {
			basis = AttestationRunnerProcessEnded
		}
		go func() {
			defer wg.Done()
			<-start
			recs[i] = f.attest(t, queued.Id, claim.RoundId, attestBody(basis, ""))
		}()
	}
	close(start)
	wg.Wait()
	for i, rec := range recs {
		if rec.Code != http.StatusOK || rec.Body.String() != recs[0].Body.String() {
			t.Fatalf("attester %d: status=%d body=%s, want 200 with the one stored result %s", i, rec.Code, rec.Body.String(), recs[0].Body.String())
		}
	}
	var rows, notes int
	if err := f.pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM round_attestations), (SELECT count(*) FROM round_activity WHERE note LIKE 'Ended by Owner attestation:%')`).Scan(&rows, &notes); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || notes != 1 {
		t.Fatalf("%d attestations and %d notes, want one of each", rows, notes)
	}
}

// Register and heartbeat lock the runners row and then flag the open Round; an attestation locks the Round and reads the
// runners row unlocked, so neither waits on the other in the opposite order.
func TestAttestCessation_InterleavesWithRegisterAndHeartbeatWithoutDeadlock(t *testing.T) {
	for trial := range 20 {
		f := newClaimFixture(t)
		queued, claim := f.runningRound(t, "Interplay")
		f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
		var attestRec, registerRec, beatRec, reconcileRec *httptest.ResponseRecorder
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(4)
		go func() {
			defer wg.Done()
			<-start
			attestRec = f.attest(t, queued.Id, claim.RoundId, attestBody(AttestationRunnerProcessEnded, ""))
		}()
		go func() {
			defer wg.Done()
			<-start
			registerRec = f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/register", body: registerBody, token: f.token})
		}()
		go func() {
			defer wg.Done()
			<-start
			beatRec = f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/heartbeat", token: f.token})
		}()
		go func() {
			defer wg.Done()
			<-start
			reconcileRec = f.reconcile(t, reconcileBody(t, heldRound(claim, HeldUnknown)))
		}()
		close(start)
		wg.Wait()
		if attestRec.Code != http.StatusOK || registerRec.Code != http.StatusOK || beatRec.Code != http.StatusOK {
			t.Fatalf("trial %d: attest %d %s, register %d, heartbeat %d", trial, attestRec.Code, attestRec.Body.String(), registerRec.Code, beatRec.Code)
		}
		if reconcileRec.Code != http.StatusOK && !(reconcileRec.Code == http.StatusConflict && strings.Contains(reconcileRec.Body.String(), roundNotOpenCode)) {
			t.Fatalf("trial %d: reconcile %d %s", trial, reconcileRec.Code, reconcileRec.Body.String())
		}
		if round := f.roundOf(t, queued.Id); round.State != RoundInterrupted {
			t.Fatalf("trial %d: Round = %+v", trial, round)
		}
	}
}
