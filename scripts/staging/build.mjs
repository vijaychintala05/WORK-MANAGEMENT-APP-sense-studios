import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, scoped, inventory, fileHash, atomicJson, verifyRelease } from './manifest.mjs';

export function buildRelease(root, revision) {
  assert.equal(process.versions.node,'24.19.0');
  const setting=loadSettings(root);
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  const commit=git('rev-parse','--verify',revision+'^{commit}');assert.match(commit,/^[a-f0-9]{40}$/);
  const release=scoped(root,path.join(setting.releaseRoot,commit));
  assert.ok(!fs.existsSync(release),'Release path already exists; preserve and inspect it before another build');
  const buildId=commit.slice(0,12)+'-'+Date.now(),builtAt=new Date().toISOString();
  const source=scoped(root,path.join('.env.staging/builds',buildId));fs.mkdirSync(source,{recursive:true});
  const archive=source+'.tar';
  execFileSync('git',['archive','--format=tar','-o',archive,commit],{cwd:root,windowsHide:true});
  execFileSync('tar.exe',['-xf',archive,'-C',source],{windowsHide:true});
  const pnpm=setting.runtime.toolchain.pnpmEntry;
  const env={...process.env,VITE_SENSE_RELEASE_COMMIT:commit,VITE_SENSE_BUILD_ID:buildId,VITE_SENSE_BUILT_AT:builtAt};
  // Source is an export of this commit, never the live working directory.
  const run=(...args)=>execFileSync(process.execPath,[pnpm,...args],{cwd:source,env,stdio:'inherit',windowsHide:true});
  run('install','--frozen-lockfile','--offline','--store-dir','D:/.pnpm-store');
  run('build');
  fs.mkdirSync(release,{recursive:true});
  run('--filter','@sense/api','deploy','--prod','--legacy','--offline',path.join(release,'api'));
  // Legacy pnpm deployment preserves workspace junctions into the build export.
  // Seal the two known workspace links inside the artifact; reject every other escape below.
  const contracts=path.join(release,'api/node_modules/.sense-workspace/contracts');fs.mkdirSync(contracts,{recursive:true});
  for(const file of ['dist','package.json'])fs.cpSync(path.join(source,'packages/contracts',file),path.join(contracts,file),{recursive:true,errorOnExist:true});
  for(const [link,expected,target] of [
    [path.join(release,'api/node_modules/@sense/contracts'),path.join(source,'packages/contracts'),contracts],
    [path.join(release,'api/node_modules/.pnpm/node_modules/@sense/api'),path.join(source,'apps/api'),path.join(release,'api')]
  ]) {
    assert.ok(fs.lstatSync(link).isSymbolicLink(),'Expected workspace junction');
    assert.equal(fs.realpathSync(link).toLowerCase(),fs.realpathSync(expected).toLowerCase(),'Unexpected workspace dependency target');
    fs.unlinkSync(link);fs.symlinkSync(target,link,'junction');
  }
  fs.cpSync(path.join(source,'apps/web/dist'),path.join(release,'web'),{recursive:true,errorOnExist:true});
  const runtime=path.join(release,'runtime');fs.mkdirSync(runtime);
  for(const file of ['manifest.mjs','server.mjs','windows.mjs','process-policy.mjs','supervisor.mjs','bootstrap.mjs','claim-lock.ps1'])fs.copyFileSync(path.join(source,'scripts/staging',file),path.join(runtime,file));
  fs.copyFileSync(process.execPath,path.join(runtime,'node.exe'));
  const migrations=fs.readdirSync(path.join(source,'apps/api/prisma/migrations'),{withFileTypes:true}).filter(row=>row.isDirectory()).map(row=>({name:row.name,checksum:fileHash(path.join(source,'apps/api/prisma/migrations',row.name,'migration.sql'))})).sort((a,b)=>a.name.localeCompare(b.name));
  const identity={commit,buildId,builtAt};
  atomicJson(path.join(release,'web/release.json'),{service:'web',mode:'release',...identity,migrations:migrations.length});
  const worker=fs.readFileSync(path.join(source,'scripts/staging/service-worker.js'),'utf8').replaceAll('__SENSE_RELEASE__',buildId);
  fs.writeFileSync(path.join(release,'web/sw.js'),worker);
  const precache=inventory(path.join(release,'web')).files.filter(row=>row.path==='index.html'||row.path.startsWith('assets/')).map(row=>({url:'/'+row.path,sha256:row.sha256}));
  atomicJson(path.join(release,'web/staging-precache.json'),{buildId,files:precache});
  const {name,user,host,port,oid,system}=setting.runtime.database;
  const manifest={schemaVersion:1,...identity,node:{version:process.versions.node,sha256:fileHash(path.join(runtime,'node.exe'))},database:{name,user,host,port,oid,system},...(migrations.length===120?{migrationProfile:'task-review-work-routing-20261023'}:{}),migrations,...inventory(release)};
  atomicJson(path.join(release,'private-manifest.json'),manifest);verifyRelease(release,manifest);
  atomicJson(source+'.receipt.json',{commit,buildId,builtAt,release,manifestSha256:fileHash(path.join(release,'private-manifest.json')),status:'BUILT_NOT_PROMOTED'});
  return {commit,buildId,release};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildRelease(path.resolve(process.argv[2]),process.argv[3])));
