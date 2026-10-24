import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const fileHash = file => sha256(fs.readFileSync(file));
export function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
export function scoped(root, relative) {
  const result = path.resolve(root, relative);
  assert.ok(inside(root, result), 'Path must remain inside its declared root');
  return result;
}
export function loadSettings(root = repositoryRoot) {
  const setting = JSON.parse(fs.readFileSync(path.join(root, 'config/staging.json')));
  const runtime = JSON.parse(fs.readFileSync(path.join(root, 'config/local-runtime.json')));
  assert.equal(setting.version, 1);
  for (const key of ['releaseRoot', 'activePointer', 'runtimeState', 'controlRoot', 'logRoot', 'postgresData']) scoped(root, setting[key]);
  assert.equal(runtime.webOrigin, 'http://localhost:59443');
  assert.equal(runtime.webPort, 59443); assert.equal(runtime.apiPort, 59442);
  assert.equal(runtime.database.host, '127.0.0.1'); assert.equal(runtime.database.port, 45434); assert.ok([119, 120].includes(runtime.database.migrations));
  if (runtime.database.migrations === 120) assert.equal(runtime.database.migrationProfile, 'task-review-work-routing-20261023');
  return { ...setting, runtime, root };
}
export function inventory(root) {
  const files = [], links = [];
  const canonical = fs.realpathSync(root);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), rel = path.relative(root, file).replaceAll('\\', '/');
      if (rel === 'private-manifest.json') continue;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const final = fs.realpathSync(file);
        assert.ok(inside(canonical, final), 'Release dependency link leaves the immutable artifact');
        links.push({ path: rel, target });
      } else if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({ path: rel, bytes: stat.size, sha256: fileHash(file) });
      else throw new Error('Unexpected artifact entry');
    }
  }
  walk(root);
  files.sort((a,b) => a.path.localeCompare(b.path)); links.sort((a,b) => a.path.localeCompare(b.path));
  return { files, links };
}
export function verifyRelease(releaseRoot, manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.match(manifest.buildId, /^[a-zA-Z0-9._-]{1,100}$/);
  assert.ok([119, 120].includes(manifest.migrations.length));
  assert.equal(manifest.migrations[118].name, '20261015000000_task_creation_receipts');
  if (manifest.migrations.length === 120) {
    assert.equal(manifest.migrationProfile, 'task-review-work-routing-20261023');
    assert.equal(manifest.migrations[119].name, '20261023000000_task_review_work_routing');
  }
  assert.equal(new Set(manifest.migrations.map(row => row.name)).size, manifest.migrations.length);
  assert.deepEqual(manifest.migrations.map(row => row.name), manifest.migrations.map(row => row.name).toSorted());
  for (const row of manifest.migrations) { assert.match(row.name, /^\d{14}_[a-z0-9_]+$/); assert.match(row.checksum, /^[a-f0-9]{64}$/); }
  assert.deepEqual(inventory(releaseRoot), { files: manifest.files, links: manifest.links }, 'Release files or dependency links changed');
  return manifest;
}
export function loadActive(root = repositoryRoot) {
  const setting = loadSettings(root);
  const pointer = JSON.parse(fs.readFileSync(scoped(root, setting.activePointer), 'utf8'));
  assert.match(pointer.commit, /^[a-f0-9]{40}$/);
  const release = scoped(root, path.join(setting.releaseRoot, pointer.commit));
  assert.equal(fs.realpathSync(release).toLowerCase(), release.toLowerCase(), 'Release path is redirected');
  const file = path.join(release, 'private-manifest.json');
  assert.equal(fileHash(file), pointer.manifestSha256, 'Release approval pointer differs');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifest.commit, pointer.commit);
  assert.equal(manifest.migrations.length, setting.runtime.database.migrations, 'Release schema requires explicit runtime configuration approval');
  const {name,user,host,port,oid,system} = setting.runtime.database;
  assert.deepEqual(manifest.database,{name,user,host,port,oid,system},'Release targets a different database');
  return { setting, release, manifest: verifyRelease(release, manifest), pointer };
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  fs.renameSync(temporary, file);
}

export function promoteRelease(root, commit, evidence) {
  const setting = loadSettings(root);
  assert.match(commit ?? '', /^[a-f0-9]{40}$/);
  assert.equal(evidence.status, 'PASS', 'Passing explicit release acceptance required');
  assert.equal(evidence.commit, commit);
  const release = scoped(root, path.join(setting.releaseRoot, commit));
  const manifestFile = path.join(release, 'private-manifest.json');
  assert.equal(fs.realpathSync(release).toLowerCase(), release.toLowerCase(), 'Release path is redirected');
  const manifest = verifyRelease(release, JSON.parse(fs.readFileSync(manifestFile)));
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.migrations.length, setting.runtime.database.migrations, 'Release schema requires explicit runtime configuration approval');
  if (manifest.migrations.length === 120) assert.equal(manifest.migrationProfile, setting.runtime.database.migrationProfile);
  const {name,user,host,port,oid,system} = setting.runtime.database;
  assert.deepEqual(manifest.database, {name,user,host,port,oid,system}, 'Release targets a different database');
  const manifestSha256 = fileHash(manifestFile);
  assert.equal(evidence.manifestSha256, manifestSha256, 'Acceptance covers a different artifact');
  const pointer = scoped(root, setting.activePointer);
  if (fs.existsSync(pointer)) fs.copyFileSync(pointer, pointer + '.preserved-' + Date.now(), fs.constants.COPYFILE_EXCL);
  atomicJson(pointer, {commit, manifestSha256});
  return {promoted: commit, buildId: manifest.buildId};
}
