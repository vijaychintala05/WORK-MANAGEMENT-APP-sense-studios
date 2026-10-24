import { recoveryTestSource } from "../../apps/api/src/recovery-test-target.ts";
// Dedicated new-schema fixtures. The accepted recovery119 harness remains unchanged.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, createConnection } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const api = resolve(root, 'apps/api');
const baselineRepository = process.env.SENSE_REVIEW_BASE_REPOSITORY ?? root;
const { Client } = createRequire(resolve(api, 'package.json'))('pg');
const bin = 'C:/Program Files/PostgreSQL/18/bin';
const pnpm = 'C:/Users/HI/AppData/Local/node/corepack/v1/pnpm/11.19.0/bin/pnpm.cjs';
const [action = 'prepare', runId = `${Date.now()}_${randomBytes(6).toString('hex')}`, ...arguments_] = process.argv.slice(2);
assert.match(runId, /^\d{13}_[a-f0-9]{12}$/);
assert.ok(['prepare', 'run', 'stop', 'stop-incomplete'].includes(action));
const base = resolve(root, '.env.review-routing-20261023', runId);
const privatePath = resolve(base, 'private.json');
const env = { ...process.env, NODE_ENV: 'test' };
for (const key of Object.keys(env)) if (/DATABASE_URL|PRESERVATION|SOURCE_DATABASE|UPGRADE_DATABASE|SENSE_RECOVERY_TEST_MANIFEST|^S27_TEST_ENV_FILE$/.test(key)) delete env[key];
function save(path, value) { writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx' }); }
function sqlName(name) { assert.match(name, /^[a-z][a-z0-9_]{0,62}$/); return `"${name}"`; }
async function run(program, args, cwd, log, childEnv = env, pgStart = false) {
  await new Promise((done, fail) => {
    const child = spawn(program, args, { cwd, env: childEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(log, "");
    const chunks = [];
    const output = chunk => { chunks.push(chunk); appendFileSync(log, chunk); };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.on('error', fail);
    child.on(pgStart ? 'exit' : 'close', code => {
      if (pgStart) { child.stdout.destroy(); child.stderr.destroy(); }
      const output = Buffer.concat(chunks).toString('utf8');
      writeFileSync(log, output);
      if (code === 0) done(); else fail(new Error(`Owned command failed (${code}); see ${log}`));
    });
  });
}
async function connect(url) { const client = new Client({ connectionString: url }); await client.connect(); return client; }
function baseline() {
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'f65fe16b24a81abf12034f0039ed55a2ca2be163', 'apps/api/prisma/migrations'], { cwd: baselineRepository, encoding: 'utf8' }).trim().split(/\r?\n/).filter(path => path.endsWith('/migration.sql'));
  assert.equal(paths.length, 119, 'Reviewed migration119 baseline is required');
  for (const path of paths) assert.ok(readFileSync(resolve(root, path)).equals(execFileSync('git', ['show', `f65fe16b24a81abf12034f0039ed55a2ca2be163:${path}`], { cwd: baselineRepository })), 'Historical migration changed');
  const added = 'apps/api/prisma/migrations/20261023000000_task_review_work_routing/migration.sql';
  return createHash('sha256').update(readFileSync(resolve(root, added))).digest('hex');
}
async function service(args, serviceEnv, cwd, log, readyUrl) {
  const endpoint = new URL(readyUrl);
  await new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(Number(endpoint.port), '127.0.0.1', () => server.close(done)); });
  writeFileSync(log, "");
  const child = spawn(process.execPath, args, { cwd, env: serviceEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => appendFileSync(log, chunk)); child.stderr.on('data', chunk => appendFileSync(log, chunk));
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Owned service exited; see ${log}`);
      try {
        if (readyUrl.startsWith('tcp://')) {
          const target = new URL(readyUrl);
          await new Promise((done, fail) => { const socket = createConnection({ host: target.hostname, port: Number(target.port) }); socket.once('connect', () => { socket.destroy(); done(); }); socket.once('error', fail); });
          return child;
        }
        if ((await fetch(readyUrl)).ok) return child;
      } catch { /* wait for owned server readiness */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Owned service readiness timed out; see ${log}`);
  } catch (error) { child.kill(); throw error; }
}
async function stopService(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}
if (action === 'stop-incomplete') {
  assert.ok(!existsSync(privatePath), 'Use ordinary verified stop for a recorded fixture');
  const password = readFileSync(resolve(base, 'init-password'), 'utf8');
  assert.match(password, /^[a-f0-9]{64}$/);
  for (const [name, port] of [['main', 58440], ['client', 58441]]) {
    const data = resolve(base, name, 'data');
    if (!existsSync(resolve(data, 'postmaster.pid'))) continue;
    const db = await connect(`postgresql://sense_review_admin:${password}@127.0.0.1:${port}/postgres`);
    const identity = (await db.query("SELECT current_setting('data_directory') AS directory, inet_server_port() AS port, system_identifier::text AS system FROM pg_control_system()")).rows[0];
    await db.end(); assert.equal(resolve(identity.directory), data); assert.equal(identity.port, port);
    save(resolve(base, `${name}-interrupted-ownership.json`), identity);
    await run(resolve(bin, 'pg_ctl.exe'), ['-D', data, '-m', 'fast', '-w', 'stop'], root, resolve(base, `${name}-interrupted-stop.log`));
  }
  console.log('Interrupted owned fixture processes stopped; evidence preserved.');
} else if (action === 'prepare') {
  assert.equal(process.versions.node, '24.19.0');
  assert.ok(!existsSync(base), 'Never reuse or reset an existing fixture');
  baseline();
  for (const port of [58440, 58441]) await new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(port, '127.0.0.1', () => server.close(done)); });
  mkdirSync(base, { recursive: true });
  const state = { runId, base, purpose: 'Owner-authorized task review evidence/routing; dedicated new schema only', migrationHash: baseline(), source: recoveryTestSource(root), environment: {}, clusters: [] };
  const adminPassword = randomBytes(32).toString('hex'), runtimePassword = randomBytes(32).toString('hex');
  const pw = resolve(base, 'init-password'); writeFileSync(pw, adminPassword, { flag: 'wx' });
  const url = (port, database, runtime = false) => `postgresql://${runtime ? 'sense_app_runtime' : 'sense_review_admin'}:${runtime ? runtimePassword : adminPassword}@127.0.0.1:${port}/${database}`;
  state.environment = { ...env, SENSE_REVIEW_ROUTING_TEST_RUN: runId, S27_E2E_ENABLED: '1', S25_E2E_ENABLED: '1', S16_E2E_ENABLED: '1', S27_EXPECTED_MIGRATIONS: '120', API_TEST_WORKERS: '2', VITEST_WORKERS: '2', PLAYWRIGHT_WORKERS: '1', TEMP: resolve(base, 'tmp'), TMP: resolve(base, 'tmp'), NAS_ROOT: resolve(baselineRepository, `.env.review-files-${runId}`), BREVO_API_KEY: '', BREVO_SENDER_EMAIL: '', BREVO_SENDER_NAME: '', OWNER_BOOTSTRAP_EMAIL: '', OWNER_BOOTSTRAP_SECRET: '' };
  mkdirSync(state.environment.TEMP); mkdirSync(state.environment.NAS_ROOT);
  for (const [clusterName, port] of [['main', 58440], ['client', 58441]]) {
    const data = resolve(base, clusterName, 'data'); mkdirSync(dirname(data));
    await run(resolve(bin, 'initdb.exe'), ['-D', data, '-U', 'sense_review_admin', '--auth-local=scram-sha-256', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C', `--pwfile=${pw}`], root, resolve(base, `${clusterName}-init.log`));
    await run(resolve(bin, 'pg_ctl.exe'), ['-D', data, '-l', resolve(base, `${clusterName}-postgres.log`), '-o', `-h 127.0.0.1 -p ${port} -c timezone=UTC -c max_connections=80`, '-w', '-t', '30', 'start'], root, resolve(base, `${clusterName}-start.log`), env, true);
    const cluster = { name: clusterName, data, port, adminUrl: url(port, 'postgres'), systemId: '' }; state.clusters.push(cluster);
    const admin = await connect(cluster.adminUrl);
    const identity = (await admin.query("SELECT current_setting('data_directory') AS directory, system_identifier::text AS system FROM pg_control_system()")).rows[0];
    assert.equal(resolve(identity.directory), data); cluster.systemId = identity.system;
    writeFileSync(privatePath, JSON.stringify(state, null, 2));
    await admin.query(`CREATE ROLE sense_app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${runtimePassword}'`);
    await admin.query('GRANT pg_read_all_settings TO sense_app_runtime WITH INHERIT TRUE');
    await admin.query('GRANT EXECUTE ON FUNCTION pg_control_system() TO sense_app_runtime');
    const database = `sense_${clusterName === 'main' ? 's27_main' : 's14'}_s27_${runId}_test`;
    await admin.query(`CREATE DATABASE ${sqlName(database)} OWNER sense_review_admin`); await admin.end();
    const runtimeUrl = url(port, database, true);
    await run(process.execPath, [resolve(api, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], api, resolve(base, `${clusterName}-migrations.log`), { ...state.environment, DATABASE_URL: runtimeUrl, MIGRATION_DATABASE_URL: url(port, database) });
    const db = await connect(url(port, database));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).rows[0].n, 120);
    if (clusterName === 'client') {
    await db.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [randomUUID(), 'Dedicated review routing fixture']);
    await db.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [randomUUID(), `review-owner-${runId}@example.test`]);
    }
    await db.query(`COMMENT ON DATABASE ${sqlName(database)} IS 'task-review-routing:${runId}:${clusterName}'`);
    await db.end();
    state.environment[clusterName === 'main' ? 'DATABASE_URL' : 'S14_DATABASE_URL'] = runtimeUrl;
    if (clusterName === 'main') state.environment.S13_DATABASE_URL = runtimeUrl;
    save(resolve(base, `${clusterName}-ownership.json`), cluster);
  }
  const main = state.clusters.find(cluster => cluster.name === 'main');
  const template = `sense_s27_main_s27_${runId}_test`;
  for (const key of ['S12_DATABASE_URL','S13_DATABASE_URL','S15_DATABASE_URL','S16_DATABASE_URL','S17_DATABASE_URL','S18_DATABASE_URL','S19_DATABASE_URL','S20_DATABASE_URL','S21_DATABASE_URL','S22_DATABASE_URL','S23_DATABASE_URL','S24_DATABASE_URL','S24_SECURITY_DATABASE_URL','S25_DATABASE_URL','S25_SECURITY_DATABASE_URL','S26_DATABASE_URL','S26_SECURITY_DATABASE_URL','S27_DATABASE_URL','S27_SECURITY_DATABASE_URL','S27_PARITY_DATABASE_URL']) {
    const number = /^S([0-9]+)/.exec(key)[1];
    const database = `sense_s${number}${key.includes('_SECURITY_') ? '_security' : key.includes('_PARITY_') ? '_parity' : ''}_s27_${runId}_test`;
    const admin = await connect(main.adminUrl);
    await admin.query(`CREATE DATABASE ${sqlName(database)} WITH TEMPLATE ${sqlName(template)} OWNER sense_review_admin`);
    await admin.query(`COMMENT ON DATABASE ${sqlName(database)} IS 'task-review-routing:${runId}:${key}'`);
    await admin.end();
    if (key === 'S27_PARITY_DATABASE_URL') { const target = await connect(url(main.port, database)); await target.query('INSERT INTO organizations(id,name,"updatedAt") VALUES($1,$2,CURRENT_TIMESTAMP)', [randomUUID(), 'Review routing parity fixture']); await target.query('INSERT INTO accounts(id,"normalizedEmail",kind,state,"updatedAt") VALUES($1,$2,\'OWNER\',\'ACTIVE\',CURRENT_TIMESTAMP)', [randomUUID(), `review-parity-${runId}@example.test`]); await target.end(); }
    if (key === 'S22_DATABASE_URL') { const target = await connect(url(main.port, database)); await target.query('GRANT USAGE, CREATE ON SCHEMA public TO sense_app_runtime'); await target.query('ALTER TABLE audit_events OWNER TO sense_app_runtime'); await target.end(); }
    state.environment[key] = url(main.port, database, true);
  }
  Object.assign(state.environment, { E2E_API_PORT: '58430', E2E_WEB_PORT: '58431', S16_TEST_RECEIVER: '1', S16_TEST_RECEIVER_HOST: '127.0.0.1', S16_TEST_RECEIVER_PORT: '58432', TIME_ACCOUNTING_RECEIVER_URL: 'http://127.0.0.1:58432', PLAYWRIGHT_BROWSERS_PATH: 'C:/Users/HI/AppData/Local/ms-playwright', S25_E2E_PRODUCTION_PREVIEW: '1', S27_E2E_PRODUCTION_PREVIEW: '1' });
  mkdirSync(resolve(root, '.env.s27-tools'), { recursive: true });
  const compatibility = `.env.s27-tools/s27-fresh-${runId}.test`;
  state.environment.S27_TEST_ENV_FILE = compatibility;
  writeFileSync(resolve(root, compatibility), Object.entries(state.environment).filter(([key]) => /DATABASE_URL|^NODE_ENV$|^S27_/.test(key)).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx' });
  writeFileSync(privatePath, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ runId, ready: true, migrations: 120, retainedTargetsTouched: false }));
} else {
  const state = JSON.parse(readFileSync(privatePath, 'utf8'));
  for (const cluster of state.clusters) {
    const db = await connect(cluster.adminUrl);
    const row = (await db.query("SELECT current_setting('data_directory') AS directory, inet_server_port() AS port, system_identifier::text AS system FROM pg_control_system()")).rows[0]; await db.end();
    assert.equal(resolve(row.directory), cluster.data); assert.equal(row.port, cluster.port); assert.equal(row.system, cluster.systemId);
  }
  if (action === 'stop') {
    for (const cluster of state.clusters) await run(resolve(bin, 'pg_ctl.exe'), ['-D', cluster.data, '-m', 'fast', '-w', 'stop'], root, resolve(base, `${cluster.name}-stop.log`));
    console.log('Owned review fixture processes stopped; all data and logs preserved.');
  } else {
    assert.equal(baseline(), state.migrationHash, 'Prepare a new fixture for a changed migration');
    assert.deepEqual(recoveryTestSource(root), state.source, 'Prepare a fresh fixture for changed candidate source');
    assert.ok(arguments_.length, 'Provide pnpm arguments after the run identifier');
    const testEnv = { ...state.environment };
    for (const key of ['S02_E2E_BOOTSTRAP_SECRET', 'EMAIL_VERIFICATION_SECRET', 'EXTERNAL_SHARE_SECRET', 'S16_TEST_RECEIVER_TOKEN']) testEnv[key] = randomBytes(32).toString('hex');
    testEnv.PLAYWRIGHT_JSON_OUTPUT_NAME = resolve(base, `browser-${Date.now()}.json`);
    testEnv.S22_PWA_PREVIEW_URL = 'http://localhost:58323';
    testEnv.S27_RUN_ID = 'review-' + runId.replace('_', '-');
    testEnv.S27_SCREENSHOT_DIR = resolve(root, '.env.s27-tools/runs', testEnv.S27_RUN_ID, 'screenshots');
    testEnv.S18_SCREENSHOT_DIR = resolve(root, '.env.s18-tools/runs', testEnv.S27_RUN_ID, 'screenshots');
    testEnv.S26_SCREENSHOT_DIR = resolve(base, 'automation-screenshots');
    const stamp = Date.now();
    const check = (args, name) => run(process.execPath, [pnpm, ...args], root, resolve(base, `${name}-${stamp}.log`), testEnv);
    const receiver = () => service([resolve(root, 'scripts/s16-accounting-test-receiver.mjs')], testEnv, root, resolve(base, `receiver-${stamp}.log`), 'tcp://127.0.0.1:58432');
    const integration = async () => { const process = await receiver(); try { await check(['test:integration'], 'postgres'); } finally { await stopService(process); } };
    const browser = async () => {
      const owned = [];
      try {
        owned.push(await receiver());
        owned.push(await service([resolve(api, 'dist/main.js')], { ...testEnv, PORT: '58324', WEB_ORIGIN: 'http://localhost:58323', OWNER_BOOTSTRAP_EMAIL: 's02-e2e-owner@example.test', OWNER_BOOTSTRAP_SECRET: testEnv.S02_E2E_BOOTSTRAP_SECRET }, root, resolve(base, `pwa-api-${stamp}.log`), 'http://127.0.0.1:58324/api/v1/health/ready'));
        owned.push(await service([resolve(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '58323', '--strictPort'], { ...testEnv, API_PROXY_TARGET: 'http://127.0.0.1:58324' }, resolve(root, 'apps/web'), resolve(base, `pwa-web-${stamp}.log`), 'http://127.0.0.1:58323/'));
        await check(['exec', 'playwright', 'test', '--config', 'scripts/acceptance/review-routing-playwright.config.ts', '--workers=1', '--retries=0'], 'browser');
      } finally { for (const process of owned.reverse()) await stopService(process); }
    };
    if (arguments_.length === 1 && ['verify', 'quality-postgres'].includes(arguments_[0])) {
      await check(['typecheck'], 'typecheck'); await check(['lint'], 'lint'); await check(['test:unit'], 'unit');
      await integration(); await check(['build'], 'build'); if (arguments_[0] === 'verify') await browser();
    } else if (arguments_.length === 1 && arguments_[0] === 'test:integration') await integration();
    else if (arguments_.length === 1 && arguments_[0] === 'test:e2e') await browser();
    else await check(arguments_, 'check');
    console.log('Dedicated fixture command passed; logs preserved.');
  }
}
