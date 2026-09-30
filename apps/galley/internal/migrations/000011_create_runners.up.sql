CREATE TABLE runners (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES owners(id),
    token_hash BYTEA NOT NULL UNIQUE,
    paired_at TIMESTAMPTZ NOT NULL,
    registered_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    michelin_version TEXT,
    hostname TEXT,
    CONSTRAINT runners_one_per_owner UNIQUE (owner_id),
    CONSTRAINT runners_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
    CONSTRAINT runners_registration_complete CHECK (
        (registered_at IS NULL) = (michelin_version IS NULL)
        AND (registered_at IS NULL) = (hostname IS NULL)
        AND (registered_at IS NULL) = (last_seen_at IS NULL)
    )
);
