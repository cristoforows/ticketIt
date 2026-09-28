CREATE TABLE badges (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES owners(id),
    public_id UUID NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT badges_owner_id_id_unique UNIQUE (owner_id, id)
);

CREATE UNIQUE INDEX badges_owner_name_ci_unique ON badges (owner_id, lower(name));

ALTER TABLE tickets ADD CONSTRAINT tickets_owner_id_id_unique UNIQUE (owner_id, id);

CREATE TABLE ticket_badges (
    owner_id BIGINT NOT NULL,
    ticket_id BIGINT NOT NULL,
    badge_id BIGINT NOT NULL,
    PRIMARY KEY (ticket_id, badge_id),
    FOREIGN KEY (owner_id, ticket_id) REFERENCES tickets (owner_id, id),
    FOREIGN KEY (owner_id, badge_id) REFERENCES badges (owner_id, id)
);

CREATE INDEX ticket_badges_owner_badge_idx ON ticket_badges (owner_id, badge_id);
