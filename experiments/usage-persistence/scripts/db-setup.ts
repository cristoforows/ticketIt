import { resolveDatabaseUrl, assertDatabaseReachable } from "native-harness/src/index.js";
import { UsageObservationStore } from "../src/index.js";

/**
 * Idempotent setup for this package's own `usage_observations` table, in
 * the SAME database the native-harness package's `npm run db:setup`
 * already created/migrated (`ticketit_m1_native` by default, or
 * `NATIVE_HARNESS_DATABASE_URL`). Does not create the database itself and
 * does not touch `checkpoints`/`round_registry`; run native-harness's own
 * `npm run db:setup` first if the database does not exist yet.
 */
async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  await assertDatabaseReachable(connectionString);

  const store = UsageObservationStore.fromConnectionString(connectionString);
  await store.setup();
  await store.end();
  console.log("usage-persistence: usage_observations table ready.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
