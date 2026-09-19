import { randomUUID } from "node:crypto";
import pg from "pg";
import { FakeClock, AdmissionLedger } from "shared";
import {
  resolveDatabaseUrl,
  assertDatabaseReachable,
  createPostgresCheckpointer,
  RoundRegistry,
  type CreateHarnessAgentOptions,
} from "native-harness";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { AdmissionScope } from "../src/index.js";

/** Same default database native-harness's own boot test uses; shared across M1 native-* experiments on this machine. */
export const connectionString = resolveDatabaseUrl();

export async function assertDbReachable(): Promise<void> {
  await assertDatabaseReachable(connectionString);
}

/** One fully-provisioned test fixture: a fresh clock, ledger, checkpointer, and unique thread/round identity. */
export interface Fixture {
  readonly clock: FakeClock;
  readonly ledger: AdmissionLedger;
  readonly checkpointer: PostgresSaver;
  readonly rawPool: pg.Pool;
  readonly threadId: string;
  readonly roundId: string;
  readonly agentId: string;
  readonly account: string;
  readonly ticketId: string;
  baseScope(action: string, resource: string): AdmissionScope;
  cleanup(): Promise<void>;
}

/**
 * Builds a fresh fixture for one scenario test: unique thread ID (so
 * concurrent/repeated runs never collide -- same convention as
 * native-harness's own boot test), a FakeClock-driven ledger, and a real
 * PostgresSaver checkpointer against the shared native-harness database.
 */
export async function createFixture(namePrefix: string): Promise<Fixture> {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z");
  const ledger = new AdmissionLedger(clock);
  const checkpointer = createPostgresCheckpointer(connectionString);
  await checkpointer.setup(); // idempotent
  const rawPool = new pg.Pool({ connectionString });

  const threadId = `${namePrefix}-${randomUUID()}`;
  const roundId = randomUUID();
  const agentId = "agent-native-admission-tracer";
  const account = "fixture-account";
  const ticketId = `ticket-${namePrefix}-${randomUUID()}`;

  return {
    clock,
    ledger,
    checkpointer,
    rawPool,
    threadId,
    roundId,
    agentId,
    account,
    ticketId,
    baseScope(action: string, resource: string): AdmissionScope {
      return { roundId, ticketId, agentId, account, action, resource };
    },
    async cleanup(): Promise<void> {
      await checkpointer.deleteThread(threadId);
      await checkpointer.end();
      await rawPool.end();
    },
  };
}

export type { CreateHarnessAgentOptions };
export { RoundRegistry };

/**
 * Polls `predicate` until it returns true, instead of assuming a fixed
 * number of microtask ticks. An earlier version of scenario 2's test
 * assumed exactly two `await Promise.resolve()` ticks were enough for an
 * in-flight `_generate` call to reach `ledger.admit()`/`dispatch()` before
 * the test asserted on ledger state; that assumption was observed to be
 * fragile (it depends on how many internal await hops `createAgent`'s
 * ReAct loop and the checkpointer's initial read insert before the model
 * node runs, which is not a number this package's tests should hard-code).
 * `waitFor` replaces fixed-tick assumptions with a real condition check.
 */
export async function waitFor(
  predicate: () => boolean,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(options.message ?? `waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
