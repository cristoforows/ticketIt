package httpapi

// Lost contact outranks the rest: Galley cannot see a Round start,
// work or confirm its Stop while the runner is out of contact.
func decideWaitingReason(state OpenRoundState, stopRequested, runnerConnected bool) RoundWaitingReason {
	switch {
	case !runnerConnected:
		return WaitingRunnerDisconnected
	case stopRequested:
		return WaitingStopping
	case state == OpenRoundClaimed:
		return WaitingStarting
	default:
		return WaitingWorking
	}
}
