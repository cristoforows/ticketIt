package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// D3 S1, transcribed independently of missingAgentInputs: goal and
// Success Criteria always, a repository only for a coding Agent,
// whatever the Template.
func wantMissingInputs(kind AgentKind, present map[AgentReadinessInput]bool) []AgentReadinessInput {
	var missing []AgentReadinessInput
	for _, input := range []AgentReadinessInput{AgentReadinessInputGoal, AgentReadinessInputSuccessCriteria, AgentReadinessInputRepository} {
		if input == AgentReadinessInputRepository && kind != AgentKindCoding {
			continue
		}
		if !present[input] {
			missing = append(missing, input)
		}
	}
	return missing
}

type readinessFixture struct {
	baseURL string
	client  *http.Client
	agents  map[AgentKind]Agent
}

func newReadinessFixture(t *testing.T) readinessFixture {
	t.Helper()
	baseURL, client := devServerWithSessionForTickets(t)
	return readinessFixture{
		baseURL: baseURL,
		client:  client,
		agents: map[AgentKind]Agent{
			AgentKindResearch: createAgentHTTP(t, client, baseURL, AgentKindResearch),
			AgentKindCoding:   createAgentHTTP(t, client, baseURL, AgentKindCoding),
		},
	}
}

// Absent inputs are sent as whitespace, which must count as missing.
func (f readinessFixture) createTicket(t *testing.T, template TicketTemplate, present map[AgentReadinessInput]bool) Ticket {
	t.Helper()
	value := func(input AgentReadinessInput) *string {
		if present[input] {
			return strPtr("some " + string(input))
		}
		return strPtr(" \t ")
	}
	resp := doLifecycleRequest(t, f.client, http.MethodPost, f.baseURL+"/api/tickets", CreateTicketRequest{
		Title:           uniqueTitle(t),
		Template:        &template,
		Goal:            value(AgentReadinessInputGoal),
		SuccessCriteria: value(AgentReadinessInputSuccessCriteria),
		Repository:      value(AgentReadinessInputRepository),
	})
	if resp.status != http.StatusCreated {
		t.Fatalf("create Ticket: status = %d; error=%+v", resp.status, resp.errBody)
	}
	return resp.ticket
}

func (f readinessFixture) assignAgent(t *testing.T, id string, kind AgentKind) lifecycleResult {
	t.Helper()
	agentID := f.agents[kind].Id
	return doLifecycleRequest(t, f.client, http.MethodPut, f.baseURL+"/api/tickets/"+id+"/assignee",
		AssignTicketRequest{Type: AssignTicketRequestTypeAgent, AgentId: &agentID})
}

func (f readinessFixture) patch(t *testing.T, id string, update UpdateTicketRequest) lifecycleResult {
	t.Helper()
	return doLifecycleRequest(t, f.client, http.MethodPatch, f.baseURL+"/api/tickets/"+id, update)
}

func (f readinessFixture) fill(t *testing.T, id string, inputs []AgentReadinessInput) Ticket {
	t.Helper()
	var update UpdateTicketRequest
	for _, input := range inputs {
		switch input {
		case AgentReadinessInputGoal:
			update.Goal = strPtr("filled goal")
		case AgentReadinessInputSuccessCriteria:
			update.SuccessCriteria = strPtr("filled criteria")
		case AgentReadinessInputRepository:
			update.Repository = strPtr("owner/repo")
		}
	}
	resp := f.patch(t, id, update)
	if resp.status != http.StatusOK {
		t.Fatalf("fill %v: status = %d; error=%+v", inputs, resp.status, resp.errBody)
	}
	return resp.ticket
}

func assertReadinessRejection(t *testing.T, resp lifecycleResult, want []AgentReadinessInput) {
	t.Helper()
	if resp.status != http.StatusBadRequest || resp.errBody.Error.Code != agentReadinessIncompleteCode {
		t.Fatalf("status = %d, code = %q; want 400 %s", resp.status, resp.errBody.Error.Code, agentReadinessIncompleteCode)
	}
	if resp.errBody.Error.Missing == nil || !reflect.DeepEqual(*resp.errBody.Error.Missing, want) {
		t.Fatalf("missing = %v, want %v", resp.errBody.Error.Missing, want)
	}
	for _, input := range want {
		if !strings.Contains(resp.errBody.Error.Message, agentReadinessInputNames[input]) {
			t.Errorf("message %q does not name %s", resp.errBody.Error.Message, input)
		}
	}
}

func readinessInputSubsets() []map[AgentReadinessInput]bool {
	var subsets []map[AgentReadinessInput]bool
	for mask := 0; mask < 8; mask++ {
		subsets = append(subsets, map[AgentReadinessInput]bool{
			AgentReadinessInputGoal:            mask&1 != 0,
			AgentReadinessInputSuccessCriteria: mask&2 != 0,
			AgentReadinessInputRepository:      mask&4 != 0,
		})
	}
	return subsets
}

func presentLabel(present map[AgentReadinessInput]bool) string {
	var names []string
	for _, input := range []AgentReadinessInput{AgentReadinessInputGoal, AgentReadinessInputSuccessCriteria, AgentReadinessInputRepository} {
		if present[input] {
			names = append(names, string(input))
		}
	}
	if len(names) == 0 {
		return "titleOnly"
	}
	return strings.Join(names, "+")
}

func TestAgentReadiness_EitherOrderGrid(t *testing.T) {
	f := newReadinessFixture(t)
	for _, ordering := range []string{"readyThenAssign", "assignThenReady"} {
		for _, template := range []TicketTemplate{Basic, Coding} {
			for _, kind := range []AgentKind{AgentKindResearch, AgentKindCoding} {
				for _, present := range readinessInputSubsets() {
					want := wantMissingInputs(kind, present)
					t.Run(fmt.Sprintf("%s/%s/%s/%s", ordering, template, kind, presentLabel(present)), func(t *testing.T) {
						created := f.createTicket(t, template, present)
						var second func() lifecycleResult
						if ordering == "readyThenAssign" {
							if resp := changeStatus(t, f.client, f.baseURL, created.Id, Ready); resp.status != http.StatusOK {
								t.Fatalf("unassigned title-only Ready: status = %d; error=%+v", resp.status, resp.errBody)
							}
							second = func() lifecycleResult { return f.assignAgent(t, created.Id, kind) }
						} else {
							if resp := f.assignAgent(t, created.Id, kind); resp.status != http.StatusOK || resp.ticket.RequestingAgentWork {
								t.Fatalf("assign in Backlog: status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
							}
							second = func() lifecycleResult { return changeStatus(t, f.client, f.baseURL, created.Id, Ready) }
						}
						before := getTicketHTTP(t, f.client, f.baseURL, created.Id)

						resp := second()
						if len(want) == 0 {
							if resp.status != http.StatusOK || resp.ticket.Status != Ready || resp.ticket.AssigneeAgent == nil || !resp.ticket.RequestingAgentWork {
								t.Fatalf("complete inputs: status = %d, ticket = %+v; error=%+v", resp.status, resp.ticket, resp.errBody)
							}
							return
						}
						assertReadinessRejection(t, resp, want)
						if after := getTicketHTTP(t, f.client, f.baseURL, created.Id); !reflect.DeepEqual(after, before) {
							t.Fatalf("rejected command changed the Ticket:\n got %+v\nwant %+v", after, before)
						}

						f.fill(t, created.Id, want)
						if fixed := second(); fixed.status != http.StatusOK || !fixed.ticket.RequestingAgentWork {
							t.Fatalf("after filling %v: status = %d, requestingAgentWork = %t; error=%+v", want, fixed.status, fixed.ticket.RequestingAgentWork, fixed.errBody)
						}
					})
				}
			}
		}
	}
}

func TestAgentReadiness_RepositoryFollowsAgentKindNotTemplate(t *testing.T) {
	f := newReadinessFixture(t)
	goalAndCriteria := map[AgentReadinessInput]bool{AgentReadinessInputGoal: true, AgentReadinessInputSuccessCriteria: true}
	for _, tc := range []struct {
		template TicketTemplate
		kind     AgentKind
		want     []AgentReadinessInput
	}{
		{Coding, AgentKindResearch, nil},
		{Basic, AgentKindCoding, []AgentReadinessInput{AgentReadinessInputRepository}},
	} {
		t.Run(string(tc.template)+"_"+string(tc.kind), func(t *testing.T) {
			created := f.createTicket(t, tc.template, goalAndCriteria)
			f.assignAgent(t, created.Id, tc.kind)
			resp := changeStatus(t, f.client, f.baseURL, created.Id, Ready)
			if tc.want == nil {
				if resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
					t.Fatalf("status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
				}
				return
			}
			assertReadinessRejection(t, resp, tc.want)
		})
	}
}

func TestAgentReadiness_SwitchingToCodingAgentOnReadyTicketNeedsRepository(t *testing.T) {
	f := newReadinessFixture(t)
	created := f.createTicket(t, Coding, map[AgentReadinessInput]bool{AgentReadinessInputGoal: true, AgentReadinessInputSuccessCriteria: true})
	f.assignAgent(t, created.Id, AgentKindResearch)
	if resp := changeStatus(t, f.client, f.baseURL, created.Id, Ready); resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
		t.Fatalf("research Agent Ready: status = %d; error=%+v", resp.status, resp.errBody)
	}

	assertReadinessRejection(t, f.assignAgent(t, created.Id, AgentKindCoding), []AgentReadinessInput{AgentReadinessInputRepository})
	if kept := getTicketHTTP(t, f.client, f.baseURL, created.Id); kept.AssigneeAgent.Id != f.agents[AgentKindResearch].Id || !kept.RequestingAgentWork {
		t.Fatalf("rejected switch changed the Assignee: %+v", kept.AssigneeAgent)
	}

	f.fill(t, created.Id, []AgentReadinessInput{AgentReadinessInputRepository})
	if resp := f.assignAgent(t, created.Id, AgentKindCoding); resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
		t.Fatalf("switch after adding a repository: status = %d; error=%+v", resp.status, resp.errBody)
	}
}

func TestAgentReadiness_ClearingRequiredInputOnReadyAgentTicket(t *testing.T) {
	f := newReadinessFixture(t)
	all := map[AgentReadinessInput]bool{AgentReadinessInputGoal: true, AgentReadinessInputSuccessCriteria: true, AgentReadinessInputRepository: true}
	for _, kind := range []AgentKind{AgentKindResearch, AgentKindCoding} {
		for _, input := range []AgentReadinessInput{AgentReadinessInputGoal, AgentReadinessInputSuccessCriteria, AgentReadinessInputRepository} {
			for _, cleared := range []string{"", "   "} {
				t.Run(fmt.Sprintf("%s/%s/%q", kind, input, cleared), func(t *testing.T) {
					created := f.createTicket(t, Basic, all)
					f.assignAgent(t, created.Id, kind)
					changeStatus(t, f.client, f.baseURL, created.Id, Ready)
					var update UpdateTicketRequest
					switch input {
					case AgentReadinessInputGoal:
						update.Goal = &cleared
					case AgentReadinessInputSuccessCriteria:
						update.SuccessCriteria = &cleared
					case AgentReadinessInputRepository:
						update.Repository = &cleared
					}
					update.Context = strPtr("edited alongside")
					before := getTicketHTTP(t, f.client, f.baseURL, created.Id)

					resp := f.patch(t, created.Id, update)

					if input == AgentReadinessInputRepository && kind == AgentKindResearch {
						if resp.status != http.StatusOK || resp.ticket.Repository != "" || !resp.ticket.RequestingAgentWork {
							t.Fatalf("research Agent needs no repository: status = %d, ticket = %+v", resp.status, resp.ticket)
						}
						return
					}
					assertReadinessRejection(t, resp, []AgentReadinessInput{input})
					if after := getTicketHTTP(t, f.client, f.baseURL, created.Id); !reflect.DeepEqual(after, before) {
						t.Fatalf("rejected clear changed the Ticket:\n got %+v\nwant %+v", after, before)
					}
				})
			}
		}
	}
}

func TestAgentReadiness_ClearingIsAllowedOffReadyOrWithoutAnAgent(t *testing.T) {
	f := newReadinessFixture(t)
	all := map[AgentReadinessInput]bool{AgentReadinessInputGoal: true, AgentReadinessInputSuccessCriteria: true, AgentReadinessInputRepository: true}
	clearAll := UpdateTicketRequest{Goal: strPtr(""), SuccessCriteria: strPtr(""), Repository: strPtr("")}

	backlogAgent := f.createTicket(t, Coding, all)
	f.assignAgent(t, backlogAgent.Id, AgentKindCoding)
	if resp := f.patch(t, backlogAgent.Id, clearAll); resp.status != http.StatusOK {
		t.Fatalf("Backlog Agent Ticket: status = %d; error=%+v", resp.status, resp.errBody)
	}

	readyOwner := f.createTicket(t, Coding, all)
	assignOwnerHTTP(t, f.client, f.baseURL, readyOwner.Id)
	changeStatus(t, f.client, f.baseURL, readyOwner.Id, Ready)
	if resp := f.patch(t, readyOwner.Id, clearAll); resp.status != http.StatusOK || resp.ticket.RequestingAgentWork {
		t.Fatalf("Ready Owner Ticket: status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
	}
}

func TestAgentReadiness_IncompleteReadyAgentTicketCanStillBeFilled(t *testing.T) {
	baseURL, client, pool, ownerID := devServerWithSessionAndPoolForTickets(t)
	f := readinessFixture{baseURL: baseURL, client: client, agents: map[AgentKind]Agent{AgentKindCoding: createAgentHTTP(t, client, baseURL, AgentKindCoding)}}
	created := f.createTicket(t, Basic, nil)
	f.assignAgent(t, created.Id, AgentKindCoding)
	setTicketStatusDirect(t, pool, ownerID, created.Id, Ready)
	if got := getTicketHTTP(t, client, baseURL, created.Id); got.RequestingAgentWork {
		t.Fatal("incomplete Ready Agent Ticket requests Agent work")
	}

	if resp := f.patch(t, created.Id, UpdateTicketRequest{Goal: strPtr("g"), Constraints: strPtr("c")}); resp.status != http.StatusOK || resp.ticket.RequestingAgentWork {
		t.Fatalf("partial fill: status = %d; error=%+v", resp.status, resp.errBody)
	}
	assertReadinessRejection(t, f.patch(t, created.Id, UpdateTicketRequest{Goal: strPtr(""), SuccessCriteria: strPtr("s")}),
		[]AgentReadinessInput{AgentReadinessInputGoal, AgentReadinessInputRepository})
	if resp := f.patch(t, created.Id, UpdateTicketRequest{SuccessCriteria: strPtr("s"), Repository: strPtr("r")}); resp.status != http.StatusOK || !resp.ticket.RequestingAgentWork {
		t.Fatalf("completing fill: status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
	}
}

func TestAgentReadiness_HumanAssignedTicketsKeepTitleOnlyReady(t *testing.T) {
	baseURL, client := devServerWithSessionForTickets(t)
	for _, assignee := range []string{"unassigned", "owner"} {
		for _, template := range []TicketTemplate{Basic, Coding} {
			t.Run(assignee+"_"+string(template), func(t *testing.T) {
				created := createTicketWithTemplate(t, client, baseURL, uniqueTitle(t), template)
				if assignee == "owner" {
					assignOwnerHTTP(t, client, baseURL, created.Id)
				}
				advertised := getTicketHTTP(t, client, baseURL, created.Id).AllowedActions
				if !containsStatus(advertised.StatusChanges, Ready) || len(advertised.StatusChangeRejections) != 0 {
					t.Fatalf("advertised = %+v, want Ready with no rejections", advertised)
				}
				resp := changeStatus(t, client, baseURL, created.Id, Ready)
				if resp.status != http.StatusOK || resp.ticket.RequestingAgentWork {
					t.Fatalf("status = %d, requestingAgentWork = %t; error=%+v", resp.status, resp.ticket.RequestingAgentWork, resp.errBody)
				}
				if resp := changeStatus(t, client, baseURL, created.Id, InProgress); resp.status != http.StatusOK {
					t.Fatalf("human In Progress: status = %d; error=%+v", resp.status, resp.errBody)
				}
			})
		}
	}
}

func TestAgentWorkRequest_ArchivedTicketsNeverRequest(t *testing.T) {
	f := newReadinessFixture(t)
	created := f.createTicket(t, Basic, map[AgentReadinessInput]bool{AgentReadinessInputGoal: true, AgentReadinessInputSuccessCriteria: true})
	f.assignAgent(t, created.Id, AgentKindResearch)
	if resp := changeStatus(t, f.client, f.baseURL, created.Id, Ready); !resp.ticket.RequestingAgentWork {
		t.Fatalf("unarchived: requestingAgentWork = false; error=%+v", resp.errBody)
	}

	archived := doLifecycleRequest(t, f.client, http.MethodPost, f.baseURL+"/api/tickets/"+created.Id+"/archive", nil)
	if archived.status != http.StatusOK || archived.ticket.Status != Ready || archived.ticket.RequestingAgentWork {
		t.Fatalf("archive response: status = %d, ticket status = %s, requestingAgentWork = %t", archived.status, archived.ticket.Status, archived.ticket.RequestingAgentWork)
	}
	if got := getTicketHTTP(t, f.client, f.baseURL, created.Id); got.RequestingAgentWork || len(got.AllowedActions.StatusChangeRejections) != 0 {
		t.Fatalf("GET archived: requestingAgentWork = %t, rejections = %+v", got.RequestingAgentWork, got.AllowedActions.StatusChangeRejections)
	}
	resp, err := f.client.Get(f.baseURL + "/api/tickets?archived=true")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var listed TicketList
	if err := json.NewDecoder(resp.Body).Decode(&listed); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("archived list: status = %d, error = %v", resp.StatusCode, err)
	}
	for _, ticket := range listed.Tickets {
		if ticket.RequestingAgentWork {
			t.Fatalf("archived list carries a Ticket requesting Agent work: %s", ticket.Id)
		}
	}

	restored := doLifecycleRequest(t, f.client, http.MethodPost, f.baseURL+"/api/tickets/"+created.Id+"/restore", nil)
	if restored.status != http.StatusOK || restored.ticket.Status != Backlog || restored.ticket.RequestingAgentWork {
		t.Fatalf("restore: status = %d, ticket status = %s, requestingAgentWork = %t", restored.status, restored.ticket.Status, restored.ticket.RequestingAgentWork)
	}
}

func TestDecideAgentWorkRequest(t *testing.T) {
	complete := ticketWorkflowState{status: Ready, agentKind: AgentKindCoding, goal: "g", successCriteria: "s", repository: "r"}
	for _, tc := range []struct {
		name   string
		change func(*ticketWorkflowState)
		want   bool
	}{
		{"complete", func(*ticketWorkflowState) {}, true},
		{"archived", func(s *ticketWorkflowState) { s.archived = true }, false},
		{"Backlog", func(s *ticketWorkflowState) { s.status = Backlog }, false},
		{"InProgress", func(s *ticketWorkflowState) { s.status = InProgress }, false},
		{"not Agent-assigned", func(s *ticketWorkflowState) { s.agentKind = "" }, false},
		{"whitespace goal", func(s *ticketWorkflowState) { s.goal = " \n\t" }, false},
		{"whitespace successCriteria", func(s *ticketWorkflowState) { s.successCriteria = "  " }, false},
		{"coding without repository", func(s *ticketWorkflowState) { s.repository = " " }, false},
		{"research without repository", func(s *ticketWorkflowState) { s.agentKind, s.repository = AgentKindResearch, "" }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := complete
			tc.change(&state)
			if got := decideAgentWorkRequest(state); got != tc.want {
				t.Fatalf("decideAgentWorkRequest(%+v) = %t, want %t", state, got, tc.want)
			}
		})
	}
}

var wantAgentOwnedMessages = map[TicketStatus]string{
	InProgress: "Execution sets In Progress on an Agent-assigned Ticket",
	InReview:   "Execution sets In Review on an Agent-assigned Ticket",
	Blocked:    "Execution sets Blocked on an Agent-assigned Ticket",
}

func TestTicketAllowedActions_MatchCommandsForEveryAssignee(t *testing.T) {
	baseURL, client, pool, ownerID := devServerWithSessionAndPoolForTickets(t)
	f := readinessFixture{baseURL: baseURL, client: client, agents: map[AgentKind]Agent{
		AgentKindResearch: createAgentHTTP(t, client, baseURL, AgentKindResearch),
		AgentKindCoding:   createAgentHTTP(t, client, baseURL, AgentKindCoding),
	}}
	complete := map[AgentReadinessInput]bool{AgentReadinessInputGoal: true, AgentReadinessInputSuccessCriteria: true, AgentReadinessInputRepository: true}
	for _, assignee := range []string{"unassigned", "owner", string(AgentKindResearch), string(AgentKindCoding)} {
		agentKind := AgentKind("")
		if assignee == string(AgentKindResearch) || assignee == string(AgentKindCoding) {
			agentKind = AgentKind(assignee)
		}
		for _, template := range []TicketTemplate{Basic, Coding} {
			for _, inputs := range []string{"complete", "titleOnly"} {
				for _, from := range allTicketStatuses {
					t.Run(fmt.Sprintf("%s/%s/%s/%s", assignee, template, inputs, from), func(t *testing.T) {
						present := complete
						if inputs == "titleOnly" {
							present = nil
						}
						created := f.createTicket(t, template, present)
						switch {
						case agentKind != "":
							f.assignAgent(t, created.Id, agentKind)
						case assignee == "owner":
							assignOwnerHTTP(t, client, baseURL, created.Id)
						}
						setTicketStatusDirect(t, pool, ownerID, created.Id, from)
						ticket := getTicketHTTP(t, client, baseURL, created.Id)
						advertised := ticket.AllowedActions
						wantRequesting := agentKind != "" && from == Ready && len(wantMissingInputs(agentKind, present)) == 0
						if ticket.RequestingAgentWork != wantRequesting {
							t.Errorf("requestingAgentWork = %t, want %t", ticket.RequestingAgentWork, wantRequesting)
						}
						if from == Blocked {
							wantRecovery := agentKind != "" && len(wantMissingInputs(agentKind, present)) == 0
							if containsStatus(advertised.StatusChanges, Ready) != wantRecovery {
								t.Errorf("Blocked -> Ready advertised %t, want %t (D3: Agent-assigned only)", containsStatus(advertised.StatusChanges, Ready), wantRecovery)
							}
						}

						for _, target := range allTicketStatuses {
							setTicketStatusDirect(t, pool, ownerID, created.Id, from)
							result := changeStatus(t, client, baseURL, created.Id, target)
							advertisedRejection := rejectionFor(advertised, target)
							switch {
							case containsStatus(advertised.StatusChanges, target):
								if result.status != http.StatusOK || result.ticket.Status != target {
									t.Errorf("%s -> %s advertised, command status %d (%+v)", from, target, result.status, result.errBody)
								}
								if _, owned := agentOwnedTargets[target]; agentKind != "" && owned {
									t.Errorf("%s -> %s advertised for an Agent-assigned Ticket", from, target)
								}
							case advertisedRejection != nil:
								if result.status != http.StatusBadRequest || !reflect.DeepEqual(result.errBody.Error, *advertisedRejection) {
									t.Errorf("%s -> %s advertised rejection %+v, command status %d %+v", from, target, *advertisedRejection, result.status, result.errBody.Error)
								}
							default:
								if result.status != http.StatusBadRequest || result.errBody.Error.Code != invalidTransitionCode {
									t.Errorf("%s -> %s not advertised, command status %d %+v", from, target, result.status, result.errBody.Error)
								}
							}
							if want, owned := wantAgentOwnedMessages[target]; agentKind != "" && d3S2AllowedPlainTransitions[[2]TicketStatus{from, target}] && owned {
								if result.errBody.Error.Code != agentOwnedTransitionCode || result.errBody.Error.Message != want {
									t.Errorf("%s -> %s on an Agent-assigned Ticket: %+v, want %s %q", from, target, result.errBody.Error, agentOwnedTransitionCode, want)
								}
							}
						}

						setTicketStatusDirect(t, pool, ownerID, created.Id, from)
						accepted := acceptTicketHTTP(t, client, baseURL, created.Id)
						if advertised.Accept.Available != (accepted.status == http.StatusOK) {
							t.Errorf("Accept from %s: advertised %t, command status %d", from, advertised.Accept.Available, accepted.status)
						}
						if !advertised.Accept.Available && !reflect.DeepEqual(*advertised.Accept.Reason, accepted.errBody.Error) {
							t.Errorf("Accept from %s: advertised %+v, command %+v", from, *advertised.Accept.Reason, accepted.errBody.Error)
						}
					})
				}
			}
		}
	}
}

func rejectionFor(actions TicketAllowedActions, target TicketStatus) *ErrorDetail {
	for _, rejection := range actions.StatusChangeRejections {
		if rejection.Status == target {
			return &rejection.Reason
		}
	}
	return nil
}

func TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply(t *testing.T) {
	baseURL, client, pool, ownerID := devServerWithSessionAndPoolForTickets(t)
	f := readinessFixture{baseURL: baseURL, client: client, agents: map[AgentKind]Agent{AgentKindResearch: createAgentHTTP(t, client, baseURL, AgentKindResearch)}}
	all := map[AgentReadinessInput]bool{AgentReadinessInputGoal: true, AgentReadinessInputSuccessCriteria: true, AgentReadinessInputRepository: true}
	const trials = 20
	for _, race := range []struct {
		name  string
		setUp func(t *testing.T, id string)
		enter func(t *testing.T, id string) lifecycleResult
	}{
		{
			name:  "clear goal vs move to Ready",
			setUp: func(t *testing.T, id string) { f.assignAgent(t, id, AgentKindResearch) },
			enter: func(t *testing.T, id string) lifecycleResult { return changeStatus(t, f.client, f.baseURL, id, Ready) },
		},
		{
			name: "clear goal vs assign an Agent while Ready",
			setUp: func(t *testing.T, id string) {
				assignOwnerHTTP(t, f.client, f.baseURL, id)
				changeStatus(t, f.client, f.baseURL, id, Ready)
			},
			enter: func(t *testing.T, id string) lifecycleResult { return f.assignAgent(t, id, AgentKindResearch) },
		},
		{
			name: "clear goal vs recover a Blocked Agent Ticket to Ready",
			setUp: func(t *testing.T, id string) {
				f.assignAgent(t, id, AgentKindResearch)
				setTicketStatusDirect(t, pool, ownerID, id, Blocked)
			},
			enter: func(t *testing.T, id string) lifecycleResult { return changeStatus(t, f.client, f.baseURL, id, Ready) },
		},
	} {
		t.Run(race.name, func(t *testing.T) {
			outcomes := map[string]int{}
			for trial := 0; trial < trials; trial++ {
				created := f.createTicket(t, Basic, all)
				race.setUp(t, created.Id)

				var wg sync.WaitGroup
				var cleared, entered lifecycleResult
				start := make(chan struct{})
				wg.Add(2)
				go func() {
					defer wg.Done()
					<-start
					cleared = f.patch(t, created.Id, UpdateTicketRequest{Goal: strPtr("")})
				}()
				go func() {
					defer wg.Done()
					<-start
					entered = race.enter(t, created.Id)
				}()
				close(start)
				wg.Wait()

				if (cleared.status == http.StatusOK) == (entered.status == http.StatusOK) {
					t.Fatalf("trial %d: clear %d (%+v), enter %d (%+v); want exactly one to apply", trial, cleared.status, cleared.errBody, entered.status, entered.errBody)
				}
				loser := entered
				if cleared.status != http.StatusOK {
					loser = cleared
				}
				assertReadinessRejection(t, loser, []AgentReadinessInput{AgentReadinessInputGoal})

				final := getTicketHTTP(t, f.client, f.baseURL, created.Id)
				if final.Status == Ready && final.AssigneeAgent != nil && final.Goal == "" {
					t.Fatalf("trial %d: Ready Agent Ticket left without a goal: %+v", trial, final)
				}
				if cleared.status == http.StatusOK {
					outcomes["clear won"]++
				} else {
					outcomes["readiness won"]++
				}
			}
			t.Logf("%d trials: %v", trials, outcomes)
		})
	}
}
