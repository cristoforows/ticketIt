package httpapi

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

const devClockMaxAdvanceSeconds = 86400

type devClock struct {
	base   func() time.Time
	offset atomic.Int64
}

func (c *devClock) Now() time.Time {
	return c.base().Add(time.Duration(c.offset.Load()))
}

func (s *server) AdvanceDevClock(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireSession(w, r); !ok {
		return
	}
	if s.devClock == nil {
		notFoundHandler(w, r)
		return
	}
	var req AdvanceDevClockRequest
	if !decodeStrictJSON(w, r, &req, `request body must be JSON matching {"seconds": 1..86400}`) {
		return
	}
	if req.Seconds < 1 || req.Seconds > devClockMaxAdvanceSeconds {
		writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf(`"seconds" must be between 1 and %d`, devClockMaxAdvanceSeconds))
		return
	}
	s.devClock.offset.Add(int64(time.Duration(req.Seconds) * time.Second))
	writeJSON(w, http.StatusOK, DevClock{Now: s.clockNow()})
}
