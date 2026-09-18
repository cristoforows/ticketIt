# 0003. PostgreSQL-backed work claims with fencing and polling before any queue technology

Status: Accepted
Date: 2026-09-19

## Context

ticketIt's v1 architecture names PostgreSQL as authoritative state ("Authoritative state: Galley and PostgreSQL," [v1-scope.md](../v1-scope.md) architecture table) and targets combined hosting/database/storage costs below $10/month excluding OpenRouter usage, with free tiers, sleep, and cold starts accepted as long as data persists. The v1 spec's "Ticket model and contracts" section states: "No queue technology beyond PostgreSQL has been selected." [deployment.md](../deployment.md) describes Michelin as authenticating to Galley and initiating outbound communication to retrieve eligible work, adding: "Initial work retrieval can use polling." [implementation-plan.md](../implementation-plan.md), "Engineering choices to make during implementation," gives the practical starting direction as "PostgreSQL-backed work claims, and polling/reconciliation before adding another queue service."

Work claiming needs to prevent two runners (or two claim attempts) from starting the same Ticket, and needs a fencing token/claim epoch so a superseded claim cannot report stale events or receive commands as if it still held the work. A dedicated queue/broker could provide this, but it is a second stateful service to operate, monitor, and pay for, which does not fit the personal-use, low-cost, sleep-tolerant deployment target, and is not required at the scale of one owner and one active Round at a time.

## Decision

Work claims are implemented as PostgreSQL transactions: an atomic claim operation admits at most one Round per eligible Ticket, issuing a fencing token/claim epoch stored alongside the Round record in the same database that holds Ticket and Round state. Michelin pulls eligible work and pending commands from Galley by polling, rather than through a push/broker system. No separate queue technology is introduced for v1.

## Consequences

- Fits the sub-$10/month cost target and the accepted free-tier/sleep/cold-start posture, since no second stateful service is operated.
- Claim admission and authoritative Ticket/Round state stay transactionally consistent in one database, which simplifies reasoning about the archive-versus-claim race and stale-token rejection described in [docs/contracts/execution-interface.md](../contracts/execution-interface.md).
- Polling adds latency compared to a push-based queue; this is accepted given sequential, single-active-Round scheduling and personal-use scale.
- Claim-table contention and polling interval/indexing need care as an engineering concern, but do not require a queue technology to solve at v1's scale; revisiting this choice is appropriate only if usage patterns later demand it, and would be a new decision, not an amendment to this one.

## References

- [v1-scope.md](../v1-scope.md), Architecture and operating constraints table, "Authoritative state."
- v1 spec ([issue #1](https://github.com/cristoforows/ticketIt/issues/1)), section "Ticket model and contracts," "No queue technology beyond PostgreSQL has been selected."
- [M1.1 (issue #12)](https://github.com/cristoforows/ticketIt/issues/12), "Work claim."
- [implementation-plan.md](../implementation-plan.md), "Engineering choices to make during implementation."
- [deployment.md](../deployment.md), "Runner lifecycle."
- [docs/contracts/execution-interface.md](../contracts/execution-interface.md), "Work claim."
