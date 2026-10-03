package httpapi

// Lost contact outranks the rest: Galley cannot see a Round start,
// work or confirm its Stop while the runner is out of contact. Stopping
// outranks the question because an answer is refused once Stop is requested.
func decideWaitingReason(state OpenRoundState, question *RoundQuestion, stopRequested, runnerConnected bool) RoundWaitingReason {
	switch {
	case !runnerConnected:
		return WaitingRunnerDisconnected
	case stopRequested:
		return WaitingStopping
	case state == OpenRoundWaitingForInput && question != nil && question.Answer != nil:
		return WaitingResuming
	case state == OpenRoundWaitingForInput:
		return WaitingForAnswer
	case state == OpenRoundClaimed:
		return WaitingStarting
	default:
		return WaitingWorking
	}
}
