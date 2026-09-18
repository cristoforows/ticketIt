import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

/** Default connection string, matching `scripts/db-setup.sh` and the README. */
export const DEFAULT_DATABASE_URL = "postgresql://localhost:5432/ticketit_m1_native";

/** Environment variable that overrides {@link DEFAULT_DATABASE_URL}. */
export const DATABASE_URL_ENV_VAR = "NATIVE_HARNESS_DATABASE_URL";

/**
 * Resolves the PostgreSQL connection string for the native harness's
 * checkpointer and Round registry, honoring `NATIVE_HARNESS_DATABASE_URL`.
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATABASE_URL_ENV_VAR];
  return override && override.trim().length > 0 ? override.trim() : DEFAULT_DATABASE_URL;
}

/**
 * Confirms the configured PostgreSQL database is reachable, throwing a clear,
 * actionable error if not. Callers (in particular `npm test`) must call this
 * before doing anything else with the database: the harness never silently
 * falls back to an in-memory or file-backed checkpointer when PostgreSQL is
 * simply unreachable.
 */
export async function assertDatabaseReachable(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    const reason = describeConnectionError(error);
    throw new Error(
      "native-harness: cannot reach the PostgreSQL database at " +
        `${redactConnectionString(connectionString)}.\n` +
        "Run the setup script first:\n" +
        "  cd experiments/native-harness && npm run db:setup\n" +
        `Or point ${DATABASE_URL_ENV_VAR} at a reachable PostgreSQL database.\n` +
        `Original error: ${reason}`,
    );
  } finally {
    await pool.end();
  }
}

/** Creates (but does not `.setup()`) a PostgreSQL-backed LangGraph checkpointer. */
export function createPostgresCheckpointer(connectionString: string): PostgresSaver {
  return PostgresSaver.fromConnString(connectionString);
}

/**
 * `pg`/`pg-pool` often reject with an `AggregateError` whose own `.message`
 * is empty (the useful detail, such as ECONNREFUSED, sits on `.code` and on
 * the nested `.errors`). Unwrap those so the failure message this function
 * throws is actually actionable.
 */
function describeConnectionError(error: unknown): string {
  if (error && typeof error === "object") {
    const code = "code" in error ? String((error as { code: unknown }).code) : undefined;
    const nested =
      "errors" in error && Array.isArray((error as { errors: unknown }).errors)
        ? ((error as { errors: unknown[] }).errors as unknown[])
            .map((nestedError) =>
              nestedError instanceof Error ? nestedError.message : String(nestedError),
            )
            .filter((message) => message.length > 0)
        : [];
    const ownMessage = error instanceof Error ? error.message : String(error);
    const parts = [ownMessage, code ? `code=${code}` : "", ...nested].filter(
      (part) => part.length > 0,
    );
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }
  return String(error);
}

function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.password = "";
    url.username = "";
    return url.toString();
  } catch {
    return connectionString;
  }
}
