package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const agentNameMaxLength = 80

const agentColumns = `public_id::text, name, kind, created_at`

func scanAgent(row ticketRowScanner) (Agent, error) {
	var agent Agent
	var created time.Time
	if err := row.Scan(&agent.Id, &agent.Name, &agent.Kind, &created); err != nil {
		return Agent{}, err
	}
	agent.CreatedAt = created.UTC().Format(time.RFC3339)
	return agent, nil
}

func (s *server) ListAgents(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	agents, err := listAgentsForOwner(ctx, s.pool, owner.ID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to read agents")
		return
	}
	writeJSON(w, http.StatusOK, AgentList{Agents: agents})
}

func listAgentsForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64) ([]Agent, error) {
	rows, err := pool.Query(ctx, `SELECT `+agentColumns+` FROM agents
		WHERE owner_id = $1 ORDER BY lower(name), public_id`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	agents := []Agent{}
	for rows.Next() {
		agent, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return agents, nil
}

func validateAgentName(w http.ResponseWriter, raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	if name == "" || utf8.RuneCountInString(name) > agentNameMaxLength {
		writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf(`"name" must be non-empty and at most %d characters after trimming`, agentNameMaxLength))
		return "", false
	}
	return name, true
}

func isDuplicateAgentName(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "agents_owner_name_ci_unique"
}

func writeDuplicateAgentName(w http.ResponseWriter) {
	writeError(w, http.StatusConflict, "duplicate_agent_name", "an agent with that name already exists")
}

func writeAgentNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "no agent with that identifier")
}

func (s *server) CreateAgent(w http.ResponseWriter, r *http.Request) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	var req CreateAgentRequest
	if !decodeStrictJSON(w, r, &req, `request body must be JSON matching {"name": "...", "kind": "research" | "coding"}`) {
		return
	}
	name, ok := validateAgentName(w, req.Name)
	if !ok {
		return
	}
	if !req.Kind.Valid() {
		writeError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf(`"kind" must be %q or %q`, AgentKindResearch, AgentKindCoding))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	agent, err := scanAgent(s.pool.QueryRow(ctx, `INSERT INTO agents (owner_id, public_id, name, kind) VALUES ($1, $2::uuid, $3, $4)
		RETURNING `+agentColumns, owner.ID, uuid.NewString(), name, string(req.Kind)))
	if isDuplicateAgentName(err) {
		writeDuplicateAgentName(w)
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to create the agent")
		return
	}
	writeJSON(w, http.StatusCreated, agent)
}

func (s *server) RenameAgent(w http.ResponseWriter, r *http.Request, id string) {
	owner, ok := s.requireSession(w, r)
	if !ok {
		return
	}
	id, ok = canonicalPublicID(id)
	if !ok {
		writeAgentNotFound(w)
		return
	}
	var req RenameAgentRequest
	if !decodeStrictJSON(w, r, &req, `request body must be JSON matching {"name": "..."}`) {
		return
	}
	name, ok := validateAgentName(w, req.Name)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ticketTimeout)
	defer cancel()
	agent, found, err := renameAgentForOwner(ctx, s.pool, owner.ID, id, name)
	if isDuplicateAgentName(err) {
		writeDuplicateAgentName(w)
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "failed to rename the agent")
		return
	}
	if !found {
		writeAgentNotFound(w)
		return
	}
	writeJSON(w, http.StatusOK, agent)
}

func renameAgentForOwner(ctx context.Context, pool *pgxpool.Pool, ownerID int64, publicID, name string) (Agent, bool, error) {
	agent, err := scanAgent(pool.QueryRow(ctx, `UPDATE agents SET name = $3
		WHERE owner_id = $1 AND public_id = $2::uuid RETURNING `+agentColumns, ownerID, publicID, name))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, false, nil
	}
	if err != nil {
		return Agent{}, false, err
	}
	return agent, true, nil
}

func agentRowIDForOwner(ctx context.Context, db ticketDB, ownerID int64, publicID string) (int64, bool, error) {
	var id int64
	err := db.QueryRow(ctx, `SELECT id FROM agents WHERE owner_id = $1 AND public_id = $2::uuid`, ownerID, publicID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return id, true, nil
}
