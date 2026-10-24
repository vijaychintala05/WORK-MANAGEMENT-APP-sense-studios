import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { inventory, verifyRelease, loadActive, atomicJson, fileHash, promoteRelease } from './manifest.mjs';
import { safeStaticPath, createStagingServer } from './server.mjs';
import { childFinished, observeChildExit, restartDelay, captureLog } from './process-policy.mjs';
import { claimSupervisorLock, processIdentity } from './windows.mjs';
import { hiddenTaskLauncher, taskAction } from './task-launcher.mjs';

test('scheduled launcher hides the console, waits for bootstrap and preserves its exit status',()=>{
  const root=path.resolve('workspace with spaces'),bootstrap=path.join(root,'.env.staging/bootstrap');
  const source=hiddenTaskLauncher(bootstrap,root),action=taskAction(bootstrap);
  assert.ok(source.includes('-WindowStyle Hidden -PassThru\r\n$null=$process.Handle\r\n$process.WaitForExit()\r\nexit $process.ExitCode'));
  assert.ok(source.includes('"'+path.join(bootstrap,'bootstrap.mjs')+'" "'+root+'"'));
  assert.equal(action.arguments,'-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "'+path.join(bootstrap,'launch-hidden.ps1')+'"');
  assert.equal(path.basename(action.execute),'powershell.exe');
});

test('Windows hidden launcher propagates a fast child failure', {skip:process.platform!=='win32'},t=>{
  const root=fixture(t),bootstrap=path.join(root,'bootstrap');fs.mkdirSync(bootstrap);
  fs.copyFileSync(process.execPath,path.join(bootstrap,'node.exe'));
  fs.writeFileSync(path.join(bootstrap,'bootstrap.mjs'),'process.exit(7);');
  fs.writeFileSync(path.join(bootstrap,'launch-hidden.ps1'),hiddenTaskLauncher(bootstrap,root));
  const result=spawnSync(taskAction(bootstrap).execute,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','RemoteSigned','-File',path.join(bootstrap,'launch-hidden.ps1')],{windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(result.error,undefined);assert.equal(result.status,7,result.stderr);
});

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sense-staging-test-'));
  t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});return dir;
}
function makeRelease(root) {
  const commit='a'.repeat(40),release=path.join(root,'.env.staging/releases',commit);fs.mkdirSync(path.join(release,'web/assets'),{recursive:true});
  fs.writeFileSync(path.join(release,'web/index.html'),'<main>approved</main>');fs.writeFileSync(path.join(release,'web/assets/app.js'),'approved');
  const migrations=Array.from({length:119},(_,i)=>({name:String(20260101000000+i)+'_test',checksum:'a'.repeat(64)}));migrations[118].name='20261015000000_task_creation_receipts';
  const database={name:'sense_retained',user:'sense_demo',host:'127.0.0.1',port:45434,oid:'145606',system:'7693570241708228348'};
  const manifest={schemaVersion:1,commit,buildId:'test-build',builtAt:new Date().toISOString(),database,migrations,...inventory(release)};
  atomicJson(path.join(release,'private-manifest.json'),manifest);
  fs.mkdirSync(path.join(root,'config'));atomicJson(path.join(root,'config/staging.json'),{version:1,releaseRoot:'.env.staging/releases',activePointer:'.env.staging/active-release.json',runtimeState:'.env.staging/runtime.json',controlRoot:'.env.staging/control',logRoot:'.env.staging/logs',postgresData:'.env.postgres/data'});
  atomicJson(path.join(root,'config/local-runtime.json'),{webOrigin:'http://localhost:59443',webPort:59443,apiPort:59442,database:{...database,migrations:119}});
  atomicJson(path.join(root,'.env.staging/active-release.json'),{commit,manifestSha256:fileHash(path.join(release,'private-manifest.json'))});
  return {release,manifest};
}
test('release approval rejects file, migration, private manifest and target changes',t=>{
  const root=fixture(t),{release,manifest}=makeRelease(root);assert.equal(loadActive(root).manifest.commit,manifest.commit);
  fs.writeFileSync(path.join(release,'web/assets/app.js'),'obsolete');assert.throws(()=>loadActive(root),/changed/);fs.writeFileSync(path.join(release,'web/assets/app.js'),'approved');
  assert.throws(()=>verifyRelease(release,{...manifest,migrations:manifest.migrations.slice(1)}));
  const altered={...manifest,database:{...manifest.database,name:'other_retained'}};atomicJson(path.join(release,'private-manifest.json'),altered);assert.throws(()=>loadActive(root),/pointer differs/);
  atomicJson(path.join(root,'.env.staging/active-release.json'),{commit:manifest.commit,manifestSha256:fileHash(path.join(release,'private-manifest.json'))});assert.throws(()=>loadActive(root),/different database/);
});
test('review120 release requires exact migration profile and explicit runtime approval',t=>{
  const root=fixture(t),{release,manifest}=makeRelease(root);
  const added={name:'20261023000000_task_review_work_routing',checksum:'b'.repeat(64)};
  const review={...manifest,migrationProfile:'task-review-work-routing-20261023',migrations:[...manifest.migrations,added]};
  assert.equal(verifyRelease(release,review).migrations.length,120);
  assert.throws(()=>verifyRelease(release,{...review,migrationProfile:'client-password'}));
  assert.throws(()=>verifyRelease(release,{...review,migrations:[...manifest.migrations,{...added,name:'20261023000000_client_password'}]}));
  atomicJson(path.join(release,'private-manifest.json'),review);
  atomicJson(path.join(root,'.env.staging/active-release.json'),{commit:review.commit,manifestSha256:fileHash(path.join(release,'private-manifest.json'))});
  assert.throws(()=>loadActive(root),/explicit runtime configuration approval/);
  const runtimePath=path.join(root,'config/local-runtime.json'),runtime=JSON.parse(fs.readFileSync(runtimePath));
  runtime.database.migrations=120;atomicJson(runtimePath,runtime);
  assert.throws(()=>loadActive(root));
  runtime.database.migrationProfile='task-review-work-routing-20261023';atomicJson(runtimePath,runtime);
  assert.equal(loadActive(root).manifest.migrations.length,120);
});
test('dependency links cannot leave the release and their exact targets are recorded',t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'one'));fs.mkdirSync(path.join(root,'two'));fs.symlinkSync(path.join(root,'one'),path.join(root,'link'),'junction');
  const before=inventory(root);fs.unlinkSync(path.join(root,'link'));fs.symlinkSync(path.join(root,'two'),path.join(root,'link'),'junction');assert.notDeepEqual(inventory(root),before);
  fs.unlinkSync(path.join(root,'link'));fs.symlinkSync(os.tmpdir(),path.join(root,'link'),'junction');assert.throws(()=>inventory(root),/leaves/);fs.unlinkSync(path.join(root,'link'));
});
test('path validation rejects encoded traversal, separators and private file paths',()=>{
  const root=path.resolve('public');for(const url of ['//host/x','/%2e%2e/secret','/%5csecret','/x/../secret','/%252e%252e/secret','/.env','/C:/secret','/%00','/%xx'])assert.equal(safeStaticPath(root,url),null,url);
  assert.equal(safeStaticPath(root,'/projects?sort=updated').pathname,'/projects');
});
test('static serving enforces public whitelist, Host, methods and fixed API failures',async t=>{
  const root=fixture(t),{release,manifest}=makeRelease(root);
  const api=http.createServer((req,res)=>{if(req.url==='/api/broken'){res.writeHead(200,{'Content-Length':100});res.write('partial');setTimeout(()=>res.destroy(),10);return;}res.writeHead(404,{'Content-Type':'application/json'}).end(JSON.stringify({path:req.url,forwarded:req.headers['x-forwarded-for']??null}));});api.listen(0,'127.0.0.1');await once(api,'listening');t.after(()=>api.close());
  const server=createStagingServer({webRoot:path.join(release,'web'),manifest,webPort:1,apiPort:api.address().port});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const request=(url,extra={})=>new Promise((resolve,reject)=>{http.request({host:'127.0.0.1',port:server.address().port,path:url,headers:{Host:'localhost:1',...extra.headers},method:extra.method??'GET'},res=>{let body='';res.on('data',data=>body+=data);res.on('aborted',()=>resolve({status:res.statusCode,aborted:true}));res.on('error',()=>resolve({status:res.statusCode,aborted:true}));res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));}).on('error',reject).end();});
  assert.equal((await request('/')).body,'<main>approved</main>');assert.equal((await request('/projects')).status,200);
  assert.equal((await request('/private-manifest.json')).status,404);assert.equal((await request('/.env')).status,400);
  fs.writeFileSync(path.join(release,'web/leaked.json'),'private');assert.equal((await request('/leaked.json')).status,404);
  assert.equal((await request('/',{headers:{Host:'foreign.example'}})).status,403);assert.equal((await request('/',{method:'POST'})).status,405);
  const proxied=await request('/api',{headers:{'x-forwarded-for':'evil'}});assert.equal(proxied.status,404);assert.deepEqual(JSON.parse(proxied.body),{path:'/api',forwarded:null});assert.equal(proxied.headers['cache-control'],'no-store');
  assert.equal((await request('/api/broken')).aborted,true);assert.equal((await request('/')).status,200,'Truncated API response must not terminate the web process');
});
test('real signal termination is recognized and restart attempts are bounded',async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),row={child,exited:false,error:null};child.on('exit',()=>row.exited=true);await once(child,'spawn');assert.equal(childFinished(row),false);child.kill('SIGTERM');await once(child,'exit');assert.equal(childFinished(row),true);
  const attempts=[];assert.equal(restartDelay(attempts,1),1000);assert.equal(restartDelay(attempts,2),2000);assert.equal(restartDelay(attempts,3),4000);assert.throws(()=>restartDelay(attempts,4),/budget/);assert.equal(restartDelay(attempts,600005),1000);
});
test('owned output stops at its byte budget without removing previous evidence',async t=>{
  const root=fixture(t),stream=new PassThrough(),file=path.join(root,'owned.log'),failures=[];captureLog(stream,file,error=>failures.push(error.message),4);stream.end('123456789');await once(stream,'close');assert.equal(fs.readFileSync(file,'utf8'),'1234');assert.equal(failures.length,1);
});

test('missing OS process recovers before its exit event, but a reused PID is refused',()=>{
  const identity={ProcessId:123,Created:'original'},row={identity,exited:false,error:null,child:{exitCode:null,signalCode:null}};
  assert.equal(observeChildExit(row,identity),false);
  assert.equal(observeChildExit(row,null),true);assert.equal(childFinished(row),true);
  assert.throws(()=>observeChildExit(row,{ProcessId:123,Created:'different'}),/identity changed/);
});
test('OS mutex serializes claims and refuses a live supervisor lock', {skip:process.platform!=='win32'},t=>{
  const root=fixture(t),file=path.join(root,'supervisor.lock.json'),identity=processIdentity(process.pid);claimSupervisorLock(file,identity,'first');assert.throws(()=>claimSupervisorLock(file,identity,'second'));assert.equal(JSON.parse(fs.readFileSync(file)).token,'first');
});

test('promotion rejects unapproved review schema before touching the active pointer', t => {
  const root=fixture(t), {release,manifest}=makeRelease(root);
  const pointer=path.join(root,'.env.staging/active-release.json'), before=fs.readFileSync(pointer);
  const review={...manifest,migrationProfile:'task-review-work-routing-20261023',migrations:[...manifest.migrations,{name:'20261023000000_task_review_work_routing',checksum:'b'.repeat(64)}]};
  const manifestFile=path.join(release,'private-manifest.json');atomicJson(manifestFile,review);
  const evidence={status:'PASS',commit:review.commit,manifestSha256:fileHash(manifestFile)};
  assert.throws(()=>promoteRelease(root,review.commit,evidence),/explicit runtime configuration approval/);
  assert.deepEqual(fs.readFileSync(pointer),before);
  assert.equal(fs.readdirSync(path.dirname(pointer)).filter(name=>name.includes('.preserved-')).length,0);
  const runtimeFile=path.join(root,'config/local-runtime.json'),runtime=JSON.parse(fs.readFileSync(runtimeFile));
  runtime.database.migrations=120;runtime.database.migrationProfile=review.migrationProfile;atomicJson(runtimeFile,runtime);
  assert.equal(promoteRelease(root,review.commit,evidence).promoted,review.commit);
  assert.equal(loadActive(root).manifest.migrations.length,120);
  assert.equal(fs.readdirSync(path.dirname(pointer)).filter(name=>name.includes('.preserved-')).length,1);
});
