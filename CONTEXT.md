# Personal task tracking

A personal workspace for tracking work through its lifecycle and delegating work to configurable AI agents.

## Language

**Owner**:
The person who controls the personal ticket collection, recipes, agents, and connected accounts. The owner authorizes agent access and reviews delivered work.
_Avoid_: Connected Account when referring to the person using ticketIt rather than an external-service identity.

**Ticket**:
A tracked unit of work with an intended outcome and a lifecycle. A ticket can be assigned to a person or an **Agent** to perform work toward that outcome.
_Avoid_: Task, issue when referring to the same tracked unit of work.

**Ticket Template**:
A reusable starting structure for a **Ticket**, defining its visible fields and sections, required information, and default completion condition. A template does not determine which agent or execution engine must perform the work.
_Avoid_: Work type when implying a permanent classification of the ticket or its execution capabilities.

**Archived Ticket**:
A **Ticket** removed from default everyday views and execution eligibility while retaining its rounds, reports, pull-request links, and usage history. Archiving requires any open agent round to end and does not imply successful completion of the work.
_Avoid_: Deleted, Done when referring to archiving.

**Booth**:
A grouping of related **Tickets** representing an area of work, whether coding or non-coding. A ticket belongs to zero or one booth; a booth can contain many tickets.
_Avoid_: Project, kitchen, store, nook when referring to this grouping.

**Badge**:
A lightweight tag used to categorize **Tickets**, describing a category rather than an outcome to complete. A ticket can have multiple badges, and a badge can categorize many tickets.
_Avoid_: Tag, label, topic when referring to this categorization.

**Agent**:
A configurable AI worker that can be assigned **Tickets**, characterized by its skills, permissions, and model settings. It investigates available context and makes reasonable, reversible assumptions within scope, seeking input only when missing information materially changes the outcome, required access or permission is unavailable, or a decision exceeds the ticket's scope.
_Avoid_: Model when referring to the complete worker rather than its underlying model.

**Manager Agent**:
An **Agent** that coordinates work across **Tickets** and agents, communicating with the **Owner** through a personal messaging platform. It helps clarify and delegate work, monitor rounds, surface blockers, and coordinate follow-ups without intervening directly in an ongoing round's model/tool execution.
_Avoid_: Owner when referring to the coordinating agent rather than the person authorizing work.

**Skill**:
Reusable instructions assigned to an **Agent** for performing a type of work. A skill describes how to work, while a **Recipe** supplies background; neither grants permission to act.
_Avoid_: Recipe when referring to reusable work instructions.

**Connected Account**:
An external-service identity authenticated by the user and made available for explicitly permitted **Agent** work. An agent using a connected account acts through that identity, such as the user's GitHub account.
_Avoid_: Agent, model provider when referring to the external identity used for work.

**Permission**:
Authorization for an **Agent** to perform actions within a resource scope, including granular grants or explicit full access through a **Connected Account**. Full access covers the actions and resources available through that connection, not capabilities beyond the account's authenticated access.
_Avoid_: Skill when referring to authorization rather than instructions.

**Temporary Permission**:
A **Permission** for an **Agent** of one of two distinct kinds: ticket-based, ending when its specified **Ticket** reaches **Done**, or time-based, ending at its configured expiry independently of ticket completion. It authorizes repeated uses within its account, action, and resource scope; ticket and time limits are not combined in one grant.
_Avoid_: One-time permission when referring to a ticket-bound or time-bound grant.

**Grill Mode**:
An optional guided interview during **Ticket** creation that helps the person adding the ticket clarify its intended outcome and supply information needed to carry out the work. People can instead fill in the ticket themselves using simple guidance.
_Avoid_: Round when referring to this preparatory interview rather than an agent carrying out the ticket's work.

**Success Criteria**:
Observable conditions used to judge whether a **Ticket**'s intended outcome has been achieved. They guide the work and the human review of its result.
_Avoid_: Done when, acceptance criteria when naming this same concept.

**Recipe**:
A reusable document supplied by a person as background information for work on **Tickets**, stored in a shared library and explicitly linked to relevant tickets. A recipe can support multiple tickets, and a ticket can link to multiple recipes.
_Avoid_: Reference document; skill when referring to supplied background rather than an agent's reusable instructions.

**Recipe Version**:
A fixed revision of a **Recipe** used as background for a **Round**. A round keeps the recipe versions selected when it starts, including when it pauses for input; later rounds use the latest versions available when they start.
_Avoid_: Live recipe when referring to the fixed content used by a round.

**Round**:
One period of an **Agent** working on a **Ticket**, with its own activity, result, and usage. A ticket can have multiple rounds; corrections during ongoing work belong to the same round, while starting again after that work ends creates another.
_Avoid_: Run, session, attempt when referring to this unit of agent work.

**Report**:
A research deliverable associated with the **Round** that produced it and presented within that round's section of its **Ticket**. Its association with the round is distinct from where the report is stored.
_Avoid_: Recipe when referring to a delivered research result rather than supplied background information.

**Assignee**:
The person or **Agent** responsible for carrying out a **Ticket**'s work. Assigning an agent to a ticket already in **Ready** requests execution; assignment outside Ready does not itself request execution.
_Avoid_: Agent when referring to an assignee who may be human.

**Status**:
A stage in a **Ticket**'s lifecycle. An unarchived ticket being both **Ready** and assigned to an **Agent** requests execution, regardless of which condition was satisfied first.
_Avoid_: Column when referring to lifecycle state rather than its visual representation on a board.

**Ready**:
The **Status** of a **Ticket** authorized and available for its **Assignee** to begin work. An agent-assigned Ready ticket has a stated goal and **Success Criteria** and is queued for execution; a human-assigned Ready ticket is available without starting automated work.
_Avoid_: Running, in progress.

**Backlog**:
The **Status** of a captured **Ticket** that is not yet authorized to begin work. A backlog ticket can be recorded with only a title and refined before becoming **Ready**.
_Avoid_: List view when referring to this lifecycle stage rather than a presentation of tickets.

**In Progress**:
The **Status** of a **Ticket** whose **Assignee** has started work. Agent-assigned tickets enter this status when execution begins; human assignees mark the start themselves.
_Avoid_: Ready, queued.

**In Review**:
The **Status** of a **Ticket** whose agent has delivered work awaiting human review and the ticket's completion condition: human acceptance or merging its reviewed pull request. Explicitly requesting rework in ticketIt returns the ticket to **Ready** for another **Round**; external review feedback alone does not.
_Avoid_: Done, completed when the delivered work has not yet been accepted.

**Done**:
The **Status** of a **Ticket** whose completion condition has been met, through human acceptance or merging its reviewed pull request. An agent finishing a **Round**, or review approval when a PR merge is required, does not by itself make the ticket Done.
_Avoid_: Agent finished when referring to acceptance of the ticket's outcome.

**Blocked**:
The **Status** of a **Ticket** that cannot proceed without intervention, including one whose **Round** is **Waiting for Input**, **Interrupted**, or **Failed**. Answering a waiting round resumes it in **In Progress**; recovery after an interrupted or failed round requires a person to return the ticket to **Ready** for another round.
_Avoid_: Ready when intervention is still required.

**Waiting for Input**:
The condition of an open **Round** paused because its **Agent** needs a human answer to proceed; answering continues the same round. Agents are expected to work autonomously and seek input only when necessary, with waiting time distinguished from active work time.
_Avoid_: Interrupted, finished when the round is still open for continuation.

**Interrupted**:
The outcome of a **Round** whose work stopped unexpectedly before delivery. Available progress and usage remain part of its history; returning execution capacity does not automatically start another round.
_Avoid_: Failed when only an unexpected interruption, rather than a work failure, is known.

**Stopped**:
The outcome of a **Round** whose execution has ended following the owner's explicit stop request. Its **Ticket** returns to **Backlog** with a Stopped **Badge**, while the round's history, usage, and available partial results remain preserved.
_Avoid_: Interrupted when the round ended through an intentional stop request.

**Failed**:
The outcome of a **Round** whose agent cannot complete the work after investigation and reasonable attempts. The **Ticket** becomes **Blocked**, retaining usage, available partial work, and an explanation of the failure.
_Avoid_: Interrupted for a known inability to complete the work; stopped for an outcome not requested by the owner.

## Example dialogue

**Developer**: Is assigning a ticket to an agent the same as choosing a model?
**Domain expert**: No. The agent includes skills and permissions as well as model settings; the model is only part of the agent.

**Developer**: Does assigning a ticket to an agent immediately start work?
**Domain expert**: If the ticket is already Ready, assigning an agent queues execution. Otherwise, it waits until it becomes Ready; it becomes In Progress only when the agent actually starts.

**Developer**: If execution is unavailable, is the ticket In Progress?
**Domain expert**: No. It remains Ready while waiting to execute.

**Developer**: Does moving my own ticket into Ready launch an agent?
**Domain expert**: No. You are its assignee, so you move it to In Progress when you start working on it.

**Developer**: The agent delivered a fix, then worked again after my feedback. Is that a new ticket?
**Domain expert**: No. It is a second round on the same ticket, with its own result and usage.

**Developer**: The agent delivered a fix with passing tests. Is the ticket Done?
**Domain expert**: It remains In Review until the reviewed pull request is merged. When I want another round, I explicitly return it to Ready in ticketIt with my feedback.

**Developer**: My laptop shut down during a round. Will the agent automatically try again when I restart it?
**Domain expert**: No. The round is Interrupted and the ticket is Blocked. I inspect the available progress, then return the ticket to Ready when I want another round.

**Developer**: The agent needs an answer before it can continue. Does my reply start another round?
**Domain expert**: No. That round is Waiting for Input and the ticket is Blocked. My answer continues the same round and returns the ticket to In Progress.

**Developer**: How can I clarify what I want before an agent starts work?
**Domain expert**: Use Grill Mode while creating the ticket to supply the necessary context. The agent can then make routine decisions within that scope without asking me about each one.

**Developer**: What is the difference between a booth and a badge?
**Domain expert**: Website is a booth grouping related tickets; Research is a badge categorizing the kind of work on a ticket.

**Developer**: Do I upload the same business background for each research ticket?
**Domain expert**: No. Add it to the shared library as a recipe, then link that recipe to the tickets that need it.

**Developer**: Is our business background a skill, and can a skill authorize access to an account?
**Domain expert**: The background is a recipe. A skill explains how to do work, such as comparing vendors; access is controlled by permissions separately.
