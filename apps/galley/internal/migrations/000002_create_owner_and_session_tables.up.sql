-- Owner identity, sessions, and OAuth anti-replay state (issue #54).
-- One Owner per deployment (docs/deployment.md, "Ownership and
-- sign-in"): the "singleton" unique constraint below enforces that at
-- the database level, not just in application logic. owner_identities
-- links the Owner to a specific provider account, matched on the
-- immutable provider_account_id rather than login (see
-- docs/evidence/m2/54-oauth-session.md for why).
CREATE TABLE owners (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    singleton BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT owners_singleton_uq UNIQUE (singleton)
);

CREATE TABLE owner_identities (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES owners(id),
    provider TEXT NOT NULL,
    provider_account_id BIGINT NOT NULL,
    login TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_account_id)
);

-- Sessions are opaque, high-entropy tokens (internal/auth.GenerateOpaqueToken):
-- only a SHA-256 hash is ever persisted. A row is deleted outright on
-- sign-out rather than marked revoked -- there is no need to retain a
-- revoked session record.
CREATE TABLE sessions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES owners(id),
    token_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- Anti-replay OAuth `state`, hashed the same way as sessions. A row is
-- deleted the moment it is consumed by the callback, so reusing the
-- same state value a second time finds no row and is rejected --
-- this, together with the state cookie the start endpoint sets, is
-- what defeats both replay and cross-session use.
CREATE TABLE oauth_states (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state_hash BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
