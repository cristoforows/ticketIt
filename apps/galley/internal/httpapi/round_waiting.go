package httpapi

// Lost contact outranks the rest: Galley cannot see a Round start,
// work or confirm its Stop while the runner is out of contact. Stopping
// outranks the ask because an answer or a Permission decision is refused
// once Stop is requested. A declined Permission request still waits for
// a Permission: only Stop ends that wait.
func decideWaitingReason(state OpenRoundState, question *RoundQuestion, request *PermissionRequest, stopRequested, runnerConnected bool) RoundWaitingReason {
	switch {
	case !runnerConnected:
		return WaitingRunnerDisconnected
	case stopRequested:
		return WaitingStopping
	case state == OpenRoundWaitingForInput && question != nil && question.Answer != nil:
		return WaitingResuming
	case state == OpenRoundWaitingForInput && request != nil && request.Decision != nil && *request.Decision == PermissionApproved:
		return WaitingResuming
	case state == OpenRoundWaitingForInput && request != nil:
		return WaitingForPermission
	case state == OpenRoundWaitingForInput:
		return WaitingForAnswer
	case state == OpenRoundClaimed:
		return WaitingStarting
	default:
		return WaitingWorking
	}
}
