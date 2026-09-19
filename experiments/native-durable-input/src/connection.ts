import {
  assertDatabaseReachable,
  createPostgresCheckpointer,
  resolveDatabaseUrl,
  RoundRegistry,
} from "native-harness/src/index.js";
import { ExecutionSnapshotStore } from "./execution-snapshot-store.js";

/**
 * Shared connection bootstrap for both process-a.ts and process-b.ts:
 * resolves the same PostgreSQL database native-harness uses (honoring
 * `NATIVE_HARNESS_DATABASE_URL`), fails loudly if it is unreachable (never
 * silently falling back -- see experiments/native-harness/README.md,
 * "Database setup"), and idempotently ensures every table this package
 * touches (`checkpoints`/etc., `round_registry`, `execution_snapshots`)
 * exists.
 */
export async function connect() {
  const connectionString = resolveDatabaseUrl();
  await assertDatabaseReachable(connectionString);

  const checkpointer = createPostgresCheckpointer(connectionString);
  await checkpointer.setup();

  const registry = RoundRegistry.fromConnectionString(connectionString);
  await registry.setup();

  const snapshotStore = ExecutionSnapshotStore.fromConnectionString(connectionString);
  await snapshotStore.setup();

  return {
    connectionString,
    checkpointer,
    registry,
    snapshotStore,
    async close(): Promise<void> {
      await checkpointer.end();
      await registry.end();
      await snapshotStore.end();
    },
  };
}
