-- A full-access grant covers the scopes its account declares in Galley's catalogue, so it records no action or resource (#167).
ALTER TABLE permission_grants ADD COLUMN full_access BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE permission_grants ALTER COLUMN action DROP NOT NULL;
ALTER TABLE permission_grants ALTER COLUMN resource DROP NOT NULL;
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_scope_follows_full_access CHECK ((action IS NULL) = full_access AND (resource IS NULL) = full_access);

-- permission_grants_request_scope_fk skips a full grant's NULL action and resource; this key still binds its Ticket, Agent and account.
ALTER TABLE permission_requests ADD CONSTRAINT permission_requests_account_unique UNIQUE (id, ticket_id, agent_id, account);
ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_request_account_fk FOREIGN KEY (request_id, ticket_id, agent_id, account)
    REFERENCES permission_requests (id, ticket_id, agent_id, account);
CREATE INDEX permission_grants_full_authority ON permission_grants (owner_id, agent_id, account) WHERE full_access;

ALTER TABLE permission_grants ADD CONSTRAINT permission_grants_renewal_account_target_unique UNIQUE (owner_id, id, agent_id, account, full_access);
ALTER TABLE permission_requests ADD COLUMN renews_full_access BOOLEAN;
UPDATE permission_requests SET renews_full_access = false WHERE renews_grant_id IS NOT NULL;
ALTER TABLE permission_requests ADD CONSTRAINT permission_requests_renews_full_access_follows_grant CHECK ((renews_grant_id IS NULL) = (renews_full_access IS NULL));
ALTER TABLE permission_requests ADD CONSTRAINT permission_requests_renews_grant_account_fk FOREIGN KEY (owner_id, renews_grant_id, agent_id, account, renews_full_access)
    REFERENCES permission_grants (owner_id, id, agent_id, account, full_access);
ALTER TABLE permission_requests DROP CONSTRAINT permission_requests_renews_grant_fk;
ALTER TABLE permission_requests ADD COLUMN renews_scoped_grant_id BIGINT GENERATED ALWAYS AS (CASE WHEN NOT renews_full_access THEN renews_grant_id END) STORED;
ALTER TABLE permission_requests ADD CONSTRAINT permission_requests_renews_grant_fk FOREIGN KEY (owner_id, renews_scoped_grant_id, agent_id, account, action, resource)
    REFERENCES permission_grants (owner_id, id, agent_id, account, action, resource);
