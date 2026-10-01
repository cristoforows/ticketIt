package httpapi

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

const agentReadinessIncompleteCode = "agent_readiness_incomplete"

const agentOwnedTransitionCode = "agent_owned_transition"

// D3 S4: execution owns these moves on an Agent-assigned Ticket.
var agentOwnedTargets = map[TicketStatus]string{InProgress: "In Progress", InReview: "In Review", Blocked: "Blocked"}

type ticketWorkflowState struct {
	status   TicketStatus
	archived bool
	// Empty unless the Ticket is Agent-assigned.
	agentKind                         AgentKind
	goal, successCriteria, repository string
	openRound                         bool
}

func workflowStateOf(ticket Ticket) ticketWorkflowState {
	state := ticketWorkflowState{
		status:          ticket.Status,
		archived:        ticket.ArchivedAt != nil,
		goal:            ticket.Goal,
		successCriteria: ticket.SuccessCriteria,
		repository:      ticket.Repository,
		openRound:       ticket.OpenRound != nil,
	}
	if ticket.AssigneeAgent != nil {
		state.agentKind = ticket.AssigneeAgent.Kind
	}
	return state
}

func (s ticketWorkflowState) agentAssigned() bool {
	return s.agentKind != ""
}

// The coding prerequisite follows the Agent's kind, never the Template
// (D3 S1). Whether the repository maps to a configured checkout is M8 #9.
func missingAgentInputs(s ticketWorkflowState) []AgentReadinessInput {
	var missing []AgentReadinessInput
	if strings.TrimSpace(s.goal) == "" {
		missing = append(missing, AgentReadinessInputGoal)
	}
	if strings.TrimSpace(s.successCriteria) == "" {
		missing = append(missing, AgentReadinessInputSuccessCriteria)
	}
	if s.agentKind == AgentKindCoding && strings.TrimSpace(s.repository) == "" {
		missing = append(missing, AgentReadinessInputRepository)
	}
	return missing
}

var agentReadinessInputNames = map[AgentReadinessInput]string{
	AgentReadinessInputGoal:            "a goal",
	AgentReadinessInputSuccessCriteria: "Success Criteria",
	AgentReadinessInputRepository:      "a repository",
}

func joinAgentReadinessInputs(inputs []AgentReadinessInput) string {
	names := make([]string, len(inputs))
	for i, input := range inputs {
		names[i] = agentReadinessInputNames[input]
	}
	if len(names) == 1 {
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

func decideAgentReadiness(s ticketWorkflowState) *transitionRejection {
	if s.status != Ready || !s.agentAssigned() {
		return nil
	}
	missing := missingAgentInputs(s)
	if len(missing) == 0 {
		return nil
	}
	return &transitionRejection{
		code:    agentReadinessIncompleteCode,
		message: fmt.Sprintf("this Ticket needs %s before a %s Agent can take it from Ready", joinAgentReadinessInputs(missing), s.agentKind),
		missing: missing,
	}
}

// decideAgentWorkRequest is the one definition of a Ticket requesting
// Agent work, and the claim's eligibility rule. An open Round has
// consumed the request.
func decideAgentWorkRequest(s ticketWorkflowState) bool {
	return !s.archived && s.status == Ready && s.agentAssigned() && len(missingAgentInputs(s)) == 0 && !s.openRound
}

func decideAssignment(s ticketWorkflowState, agentKind AgentKind) *transitionRejection {
	s.agentKind = agentKind
	return decideAgentReadiness(s)
}

// Rejects only clearing a needed input, so a Ready Agent Ticket already
// short of inputs (assigned before #128) can still be edited towards
// readiness.
func decideTicketUpdate(s ticketWorkflowState, update ticketUpdate) *transitionRejection {
	named := map[AgentReadinessInput]bool{
		AgentReadinessInputGoal:            update.goal != nil,
		AgentReadinessInputSuccessCriteria: update.successCriteria != nil,
		AgentReadinessInputRepository:      update.repository != nil,
	}
	if update.goal != nil {
		s.goal = *update.goal
	}
	if update.successCriteria != nil {
		s.successCriteria = *update.successCriteria
	}
	if update.repository != nil {
		s.repository = *update.repository
	}
	rejection := decideAgentReadiness(s)
	if rejection == nil {
		return nil
	}
	for _, input := range rejection.missing {
		if named[input] {
			return rejection
		}
	}
	return nil
}

// The caller must already hold the row lock (lockTicketForMutation).
func readLockedTicket(ctx context.Context, tx pgx.Tx, ownerID int64, publicID string) (Ticket, error) {
	return scanTicketRow(tx.QueryRow(ctx,
		`SELECT `+ticketSelectColumns+` FROM tickets WHERE owner_id = $1 AND public_id = $2::uuid`,
		ownerID, publicID,
	))
}
