ALTER TABLE permission_grants DROP CONSTRAINT permission_grants_state;
-- M5.10's states (#168); later M5 slices end ticket grants.
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_state CHECK (state IN ('active', 'revoked'));
ALTER TABLE permission_grants ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_revoked_at_follows_state CHECK ((state = 'revoked') = (revoked_at IS NOT NULL));
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_revoked_after_approval CHECK (revoked_at >= approved_at);

ALTER TABLE round_commands DROP CONSTRAINT round_commands_type_m5;
-- M5.10's command types (#168); later M5 slices replace this.
ALTER TABLE round_commands ADD CONSTRAINT round_commands_type_m5 CHECK (type IN ('stop', 'answer', 'approval', 'authority_changed'));
