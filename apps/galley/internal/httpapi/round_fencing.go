package httpapi

import "net/http"

const (
	runnerNotHolderCode    = "runner_not_holder"
	runnerNotHolderMessage = "this runner did not claim this Round"
)

// A null holder is a Round claimed before claims recorded their runner (#171): no runner holds it.
func runnerHolds(holderID *int64, runnerID int64) bool {
	return holderID != nil && *holderID == runnerID
}

func runnerNotHolderRejection() *roundEventRejection {
	return &roundEventRejection{http.StatusConflict, runnerNotHolderCode, runnerNotHolderMessage}
}
