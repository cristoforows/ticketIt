package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func reconcileBody(t *testing.T, held ...map[string]any) string {
	t.Helper()
	if held == nil {
		held = []map[string]any{}
	}
	return jsonText(t, map[string]any{"held": held})
}

func heldRound(claim RunnerClaim, execution HeldExecution) map[string]any {
	return map[string]any{"roundId": claim.RoundId, "claimEpoch": claim.ClaimEpoch, "execution": string(execution)}
}

func (f *claimFixture) reconcile(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return f.do(t, runnerCall{method: http.MethodPost, path: "/api/runner/reconcile", body: body, token: f.token})
}

func (f *claimFixture) mustReconcile(t *testing.T, body string) ReconcileResult {
	t.Helper()
	rec := f.reconcile(t, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("reconcile %s: status=%d body=%s, want 200", body, rec.Code, rec.Body.String())
	}
	var result ReconcileResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *claimFixture) mustHeartbeat(t *testing.T) RunnerHeartbeat {
	t.Helper()
	var beat RunnerHeartbeat
	if err := json.Unmarshal(f.heartbeat(t, f.token, http.StatusOK).Body.Bytes(), &beat); err != nil {
		t.Fatal(err)
	}
	return beat
}

// Heartbeats at the fixture clock's instant and, when that flags the Round, reconciles it as running.
func (f *claimFixture) reconnect(t *testing.T, claim RunnerClaim) {
	t.Helper()
	if !f.mustHeartbeat(t).ReconcileRequired {
		return
	}
	if got := f.mustReconcile(t, reconcileBody(t, heldRound(claim, HeldRunning))); got.Round == nil || got.Round.Disposition != ReconcileContinue {
		t.Fatalf("reconnect: reconcile = %+v, want continue", got.Round)
	}
}
