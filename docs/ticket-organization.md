# Ticket organization

## First iteration

Tickets belong to one shared collection. Separate booths and booth-specific views are deferred.

Support custom badges in v1: the owner can create badges, attach or remove them manually, and filter tickets by badge. The built-in Stopped badge coexists with custom badges and follows its manual-removal behavior in `ticket-views.md`. Additional badge automation is deferred.

## Future organization

Extend the shared collection with booths later while retaining the badge model used in v1. Desired views include filtering by booth, badge, and assigned agent.

Booths must be able to represent non-coding work as well as coding work. Booth grouping must not require a separate ticket type or replace existing ticket identities and round histories.

Grouping and filtering may be presented through the frontend, but durable grouping requires explicit relationships or metadata in the underlying ticket data. A frontend-only filter does not establish those relationships.

## Concepts and naming

Use **Booth** for the project-like grouping and **Badge** for a tag. Keep **Ticket** as the unit of work. The theme evokes orders being fulfilled, with agents analogous to service staff; no separate waiter or cook roles have been defined.

Epics and a separate topic concept are excluded from the current plan.

## Membership

- A ticket belongs to zero or one booth. Quick capture does not require choosing a booth.
- A booth can contain many tickets.
- A ticket can have zero or more badges; a badge can categorize many tickets.
- Overlapping categories are represented by badges rather than membership in multiple booths.
