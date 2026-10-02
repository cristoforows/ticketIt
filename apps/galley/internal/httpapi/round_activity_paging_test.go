package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func activityPath(ticketID, roundID string) string {
	return "/api/tickets/" + ticketID + "/rounds/" + roundID + "/activity"
}

func (f *claimFixture) activityPage(t *testing.T, ticketID, roundID string, before *string) *httptest.ResponseRecorder {
	t.Helper()
	path := activityPath(ticketID, roundID)
	if before != nil {
		path += "?before=" + url.QueryEscape(*before)
	}
	return f.do(t, runnerCall{method: http.MethodGet, path: path, cookie: f.cookie})
}

func decodeActivityPage(t *testing.T, rec *httptest.ResponseRecorder) RoundActivityPage {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("activity page: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	var page RoundActivityPage
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func (f *claimFixture) appendNotes(t *testing.T, roundID string, from, to int) {
	t.Helper()
	for i := from; i <= to; i++ {
		f.mustReport(t, roundID, progressEvent(t, fmt.Sprintf("note-%d", i), 1, eventOccurredAt, fmt.Sprintf("note %d", i)))
	}
}

func assertSeqs(t *testing.T, name string, notes []RoundActivityNote, first, last int) {
	t.Helper()
	if len(notes) != last-first+1 {
		t.Fatalf("%s: %d notes, want seq %d..%d", name, len(notes), first, last)
	}
	for i, note := range notes {
		if want := first + i; note.Seq != want || note.Note != fmt.Sprintf("note %d", want) {
			t.Fatalf("%s: notes[%d] = %+v, want seq %d", name, i, note, want)
		}
	}
}

func (f *claimFixture) allActivity(t *testing.T, ticketID, roundID string) []RoundActivityNote {
	t.Helper()
	page := decodeActivityPage(t, f.activityPage(t, ticketID, roundID, nil))
	notes := page.Activity
	for page.EarlierActivityCursor != nil {
		page = decodeActivityPage(t, f.activityPage(t, ticketID, roundID, page.EarlierActivityCursor))
		notes = append(page.Activity, notes...)
	}
	return notes
}

func TestRoundActivity_PagesAtTheWindowBoundaries(t *testing.T) {
	for _, tc := range []struct {
		notes int
		pages [][2]int
	}{
		{0, nil},
		{1, [][2]int{{1, 1}}},
		{50, [][2]int{{1, 50}}},
		{51, [][2]int{{2, 51}, {1, 1}}},
		{100, [][2]int{{51, 100}, {1, 50}}},
		{101, [][2]int{{52, 101}, {2, 51}, {1, 1}}},
	} {
		t.Run(fmt.Sprintf("%d notes", tc.notes), func(t *testing.T) {
			f := newClaimFixture(t)
			queued, claim := f.runningRound(t, "Paged")
			f.appendNotes(t, claim.RoundId, 1, tc.notes)

			round := f.roundOf(t, queued.Id)
			page := decodeActivityPage(t, f.activityPage(t, queued.Id, claim.RoundId, nil))
			if jsonText(t, page.Activity) != jsonText(t, round.Activity) || jsonText(t, page.EarlierActivityCursor) != jsonText(t, round.EarlierActivityCursor) {
				t.Fatalf("default page = %s, want the Round list's %s", jsonText(t, page), jsonText(t, round))
			}
			if tc.notes == 0 {
				if len(page.Activity) != 0 || page.EarlierActivityCursor != nil {
					t.Fatalf("empty Round page = %s", jsonText(t, page))
				}
				return
			}
			for i, want := range tc.pages {
				assertSeqs(t, fmt.Sprintf("page %d", i+1), page.Activity, want[0], want[1])
				last := i == len(tc.pages)-1
				if last != (page.EarlierActivityCursor == nil) {
					t.Fatalf("page %d cursor = %v, want one exactly when an earlier page exists", i+1, page.EarlierActivityCursor)
				}
				if !last {
					page = decodeActivityPage(t, f.activityPage(t, queued.Id, claim.RoundId, page.EarlierActivityCursor))
				}
			}
		})
	}
}

func TestRoundActivity_AppendsWhilePagingNeitherSkipNorDuplicate(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Busy")
	f.appendNotes(t, claim.RoundId, 1, 120)

	first := decodeActivityPage(t, f.activityPage(t, queued.Id, claim.RoundId, nil))
	assertSeqs(t, "first page", first.Activity, 71, 120)

	var appending sync.WaitGroup
	appending.Add(1)
	go func() {
		defer appending.Done()
		for i := 121; i <= 150; i++ {
			rec := f.reportEvent(t, claim.RoundId, progressEvent(t, fmt.Sprintf("note-%d", i), 1, eventOccurredAt, fmt.Sprintf("note %d", i)))
			if rec.Code != http.StatusCreated {
				t.Errorf("append %d: status=%d body=%s", i, rec.Code, rec.Body.String())
			}
		}
	}()
	notes := first.Activity
	next := 151
	for cursor := first.EarlierActivityCursor; cursor != nil; next++ {
		f.appendNotes(t, claim.RoundId, next, next)
		page := decodeActivityPage(t, f.activityPage(t, queued.Id, claim.RoundId, cursor))
		notes = append(page.Activity, notes...)
		cursor = page.EarlierActivityCursor
	}
	appending.Wait()
	assertSeqs(t, "paged while appending", notes, 1, 120)
	all := f.allActivity(t, queued.Id, claim.RoundId)
	seen := map[string]bool{}
	for i, note := range all {
		if note.Seq != i+1 || seen[note.Note] {
			t.Fatalf("after appending: notes[%d] = %+v, want seq %d and no repeated note", i, note, i+1)
		}
		seen[note.Note] = true
	}
	if len(all) != next-1 {
		t.Fatalf("after appending: %d notes, want %d", len(all), next-1)
	}
}

func TestRoundActivity_AMalformedCursorIsInvalidCursor(t *testing.T) {
	f := newClaimFixture(t)
	queued, claim := f.runningRound(t, "Bad cursors")
	f.appendNotes(t, claim.RoundId, 1, 3)
	for _, cursor := range []string{"", "0", "-1", "+2", "02", "2.0", " 2", "2 ", "abc", "0x2", "99999999999999999999"} {
		rec := f.activityPage(t, queued.Id, claim.RoundId, &cursor)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("before=%q: status=%d body=%s, want 400", cursor, rec.Code, rec.Body.String())
		}
		assertErrorCode(t, rec, invalidCursorCode)
	}
	beyond := "1000"
	assertSeqs(t, "a cursor past the newest note", decodeActivityPage(t, f.activityPage(t, queued.Id, claim.RoundId, &beyond)).Activity, 1, 3)
	oldest := "1"
	if page := decodeActivityPage(t, f.activityPage(t, queued.Id, claim.RoundId, &oldest)); len(page.Activity) != 0 || page.EarlierActivityCursor != nil {
		t.Fatalf("before the first note = %s, want an empty last page", jsonText(t, page))
	}
}

func TestRoundActivity_UnknownMismatchedAndForeignRoundsAreTheSameNotFound(t *testing.T) {
	f := newClaimFixture(t)
	queued, first := f.runningRound(t, "Mine")
	f.appendNotes(t, first.RoundId, 1, 2)
	f.deliverThroughAPI(t, first.RoundId)
	other, second := f.runningRound(t, "Also mine")

	foreignCookie, _ := secondOwnerSession(t, f.pool)
	foreign := &claimFixture{runnerFixture: f.runnerFixture}
	foreign.cookie = foreignCookie
	foreign.agent = createAgentForTest(t, f.handler, foreignCookie, "Theirs", AgentKindResearch)
	foreign.token = foreign.pair(t).Token
	foreign.register(t, foreign.token, http.StatusOK)
	theirTicket, theirs := foreign.runningRound(t, "Theirs")

	cursor := "2"
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"unknown Round":                   f.activityPage(t, queued.Id, uuid.NewString(), nil),
		"unknown Ticket":                  f.activityPage(t, uuid.NewString(), first.RoundId, nil),
		"malformed Round":                 f.activityPage(t, queued.Id, "not-a-uuid", nil),
		"malformed Ticket":                f.activityPage(t, "not-a-uuid", first.RoundId, nil),
		"another Ticket's Round":          f.activityPage(t, other.Id, first.RoundId, nil),
		"another Ticket's Round, cursor":  f.activityPage(t, queued.Id, second.RoundId, &cursor),
		"a foreign Round":                 f.activityPage(t, theirTicket.Id, theirs.RoundId, nil),
		"a foreign Round under my Ticket": f.activityPage(t, queued.Id, theirs.RoundId, nil),
		"my Round to the foreign Owner":   foreign.activityPage(t, queued.Id, first.RoundId, nil),
	} {
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status=%d body=%s, want 404", name, rec.Code, rec.Body.String())
		}
		if body := assertErrorCode(t, rec, "not_found"); body != newErrorBody("not_found", roundNotFoundMessage) {
			t.Fatalf("%s: body = %+v, want the shared Round 404", name, body)
		}
	}
	assertSeqs(t, "an ended Round", decodeActivityPage(t, f.activityPage(t, queued.Id, first.RoundId, nil)).Activity, 1, 2)
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodGet, path: activityPath(queued.Id, first.RoundId)}))
	assertUnauthenticated(t, f.do(t, runnerCall{method: http.MethodGet, path: activityPath(queued.Id, first.RoundId), token: f.token}))
}
