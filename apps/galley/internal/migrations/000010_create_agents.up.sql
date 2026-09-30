CREATE TABLE agents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES owners(id),
    public_id UUID NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agents_owner_id_id_unique UNIQUE (owner_id, id)
);

CREATE UNIQUE INDEX agents_owner_name_ci_unique ON agents (owner_id, lower(name));

ALTER TABLE tickets ADD COLUMN assignee_agent_id BIGINT;

ALTER TABLE tickets ADD CONSTRAINT tickets_assignee_agent_fk
    FOREIGN KEY (owner_id, assignee_agent_id) REFERENCES agents (owner_id, id);

-- IS NOT DISTINCT FROM: with plain =, an unassigned (NULL) Ticket carrying an Agent would pass.
ALTER TABLE tickets ADD CONSTRAINT tickets_assignee_agent_iff_agent_type
    CHECK ((assignee_type IS NOT DISTINCT FROM 'agent') = (assignee_agent_id IS NOT NULL));
