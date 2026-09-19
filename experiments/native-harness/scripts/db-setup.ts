import {
  resolveDatabaseUrl,
  createPostgresCheckpointer,
  RoundRegistry,
} from "../src/index.js";

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();

  const checkpointer = createPostgresCheckpointer(connectionString);
  await checkpointer.setup();
  await checkpointer.end();
  console.log("native-harness: checkpointer.setup() complete.");

  const registry = RoundRegistry.fromConnectionString(connectionString);
  await registry.setup();
  await registry.end();
  console.log("native-harness: round_registry table ready.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
