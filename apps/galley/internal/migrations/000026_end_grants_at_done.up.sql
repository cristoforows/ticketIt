ALTER TABLE permission_grants DROP CONSTRAINT permission_grants_state;
-- M5.11's states (#169).
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_state CHECK (state IN ('active', 'revoked', 'ended_at_done'));
ALTER TABLE permission_grants ADD COLUMN ended_at TIMESTAMPTZ;
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_ended_at_follows_state CHECK ((state = 'ended_at_done') = (ended_at IS NOT NULL));
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_ended_after_approval CHECK (ended_at >= approved_at);
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_only_ticket_form_ends_at_done CHECK (state <> 'ended_at_done' OR form = 'ticket');
