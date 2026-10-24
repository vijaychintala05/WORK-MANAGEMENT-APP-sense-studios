import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { recoveryTestSource } from "./recovery-test-target.js";
import { isS27DisposableTestTarget } from "./s27-disposable-test-target.js";
import type { Prisma } from "./generated/prisma/client.js";

/** Separate owned120 capability. Never broadens the accepted recovery119 guard. */
export function reviewRoutingTestTarget(root: string, key: "DATABASE_URL" | "S27_PARITY_DATABASE_URL", environment: NodeJS.ProcessEnv = process.env) {
  const fail = (): never => { throw new Error("Exact owned task-review120 fixture, source and identity required"); };
  if (environment.NODE_ENV !== "test" || environment.S27_EXPECTED_MIGRATIONS !== "120" || !isS27DisposableTestTarget(key, environment[key], environment)) fail();
  const runId = environment.SENSE_REVIEW_ROUTING_TEST_RUN ?? "";
  if (!/^\d{13}_[a-f0-9]{12}$/.test(runId)) fail();
  const base = resolve(root, ".env.review-routing-20261023", runId);
  if (realpathSync(base).toLowerCase() !== base.toLowerCase()) fail();
  const state = JSON.parse(readFileSync(resolve(base, "private.json"), "utf8")) as { runId: string; base: string; purpose: string; source: ReturnType<typeof recoveryTestSource>; environment: Record<string, string>; clusters: Array<{ name: string; data: string; port: number; systemId: string }> };
  if (state.runId !== runId || state.base !== base || state.purpose !== "Owner-authorized task review evidence/routing; dedicated new schema only" || state.environment[key] !== environment[key]) fail();
  if (state.source.migrations.length !== 120 || state.source.migrations.at(-1)?.name !== "20261023000000_task_review_work_routing" || JSON.stringify(recoveryTestSource(root)) !== JSON.stringify(state.source)) fail();
  const cluster = state.clusters.find(row => row.name === "main");
  if (!cluster || cluster.port !== 58440 || resolve(cluster.data) !== resolve(base, "main/data") || !/^\d+$/.test(cluster.systemId)) fail();
  return { url: environment[key]!, state, cluster: cluster!, key };
}

export async function verifyReviewRoutingTestDatabase(tx: Pick<Prisma.TransactionClient, "$queryRaw">, binding: ReturnType<typeof reviewRoutingTestTarget>) {
  const rows = await tx.$queryRaw<Array<{ database: string; port: number; directory: string; system: string; username: string; superuser: boolean; createdb: boolean; createrole: boolean; bypassrls: boolean; marker: string }>>`
    SELECT current_database() AS database, inet_server_port() AS port, current_setting('data_directory') AS directory,
      (SELECT system_identifier::text FROM pg_control_system()) AS system, current_user AS username,
      r.rolsuper AS superuser,r.rolcreatedb AS createdb,r.rolcreaterole AS createrole,r.rolbypassrls AS bypassrls,
      shobj_description(d.oid,'pg_database') AS marker
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`;
  const row = rows[0], url = new URL(binding.url);
  if (!row || row.database !== url.pathname.slice(1) || row.port !== binding.cluster.port || row.system !== binding.cluster.systemId || resolve(row.directory) !== resolve(binding.cluster.data) || row.username !== "sense_app_runtime" || row.superuser || row.createdb || row.createrole || row.bypassrls || row.marker !== `task-review-routing:${binding.state.runId}:${binding.key === "DATABASE_URL" ? "main" : binding.key}`) throw new Error("Owned review120 database identity mismatch");
  const ledger = await tx.$queryRaw<Array<{ name: string; checksum: string; finished: Date | null; rollback: Date | null }>>`SELECT migration_name AS name,checksum,finished_at AS finished,rolled_back_at AS rollback FROM _prisma_migrations ORDER BY migration_name`;
  if (ledger.some(row => !row.finished || row.rollback) || JSON.stringify(ledger.map(({ name, checksum }) => ({ name, checksum }))) !== JSON.stringify(binding.state.source.migrations)) throw new Error("Owned review120 migration evidence mismatch");
}
