ALTER TABLE permission_grants DROP CONSTRAINT permission_grants_form;
-- M5.8's forms (#166); M5.9 adds full account access.
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_form CHECK (form IN ('ticket', 'time'));
-- A time grant's ticket_id is the Ticket it was approved on, kept for the request's foreign keys; it binds nothing (#166).
ALTER TABLE permission_grants ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_expiry_follows_form CHECK ((form = 'time') = (expires_at IS NOT NULL));
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_expiry_window CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '30 days');
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_renewal_target_unique UNIQUE (owner_id, id, agent_id, account, action, resource);
CREATE INDEX permission_grants_time_authority ON permission_grants (owner_id, agent_id, account, action, resource, expires_at) WHERE form = 'time';

ALTER TABLE permission_requests ADD COLUMN renews_grant_id BIGINT;
ALTER TABLE permission_requests ADD CONSTRAINT permission_requests_renews_grant_fk FOREIGN KEY (owner_id, renews_grant_id, agent_id, account, action, resource)
    REFERENCES permission_grants (owner_id, id, agent_id, account, action, resource);

ALTER TABLE round_authority_checks ADD COLUMN expired_grant_id BIGINT;
ALTER TABLE round_authority_checks ADD CONSTRAINT round_authority_checks_expired_grant_fk FOREIGN KEY (owner_id, expired_grant_id) REFERENCES permission_grants (owner_id, id);
ALTER TABLE round_authority_checks ADD CONSTRAINT round_authority_checks_expired_grant_on_deny CHECK (expired_grant_id IS NULL OR decision = 'deny');
