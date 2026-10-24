import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, loadActive, scoped, fileHash, atomicJson, promoteRelease, repositoryRoot } from './manifest.mjs';
import { powershell, psQuote, processIdentity, sameIdentity, listeners, ownsListeners } from './windows.mjs';
import { hiddenTaskLauncher, taskAction } from './task-launcher.mjs';

const root=repositoryRoot,setting=loadSettings(root),command=process.argv[2];
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function status() {
  const active=loadActive(root),state=JSON.parse(fs.readFileSync(scoped(root,setting.runtimeState)));
  assert.equal(state.state,'READY','Staging is not READY');
  assert.equal(state.commit,active.manifest.commit);assert.equal(state.buildId,active.manifest.buildId);
  assert.ok(sameIdentity(processIdentity(state.supervisor.ProcessId),state.supervisor),'Supervisor is absent or changed');
  for(const row of Object.values(state.children))assert.ok(sameIdentity(processIdentity(row.pid),row.identity),'Owned child is absent or changed');
  ownsListeners(listeners([59442,59443]),[[59442,state.children.api.pid],[59443,state.children.web.pid]]);
  const read=async url=>{const response=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(6000)});assert.equal(response.status,200);return response.json();};
  const [web,api]=await Promise.all([read(setting.runtime.webOrigin+'/release.json'),read(setting.runtime.webOrigin+'/api/v1/health/release')]);
  await read(setting.runtime.webOrigin+'/api/v1/health/ready');
  for(const value of [web,api]){assert.equal(value.commit,active.manifest.commit);assert.equal(value.buildId,active.manifest.buildId);}
  return {state:'READY',url:setting.runtime.webOrigin+'/',commit:active.manifest.commit,buildId:active.manifest.buildId,frontend:web,backend:api,processes:state.children};
}
if(command==='status')console.log(JSON.stringify(await status(),null,2));
else if(command==='promote') {
  console.log(JSON.stringify(promoteRelease(root,process.argv[3],JSON.parse(fs.readFileSync(path.resolve(process.argv[4]??''))))));
} else if(command==='install-startup') {
  const active=loadActive(root),bootstrap=scoped(root,'.env.staging/bootstrap');
  assert.ok(!fs.existsSync(bootstrap),'Bootstrap already installed; inspect before updating');fs.mkdirSync(bootstrap,{recursive:true});
  for(const file of ['bootstrap.mjs','manifest.mjs','process-policy.mjs','node.exe'])fs.copyFileSync(path.join(active.release,'runtime',file),path.join(bootstrap,file));
  fs.writeFileSync(path.join(bootstrap,'launch-hidden.ps1'),hiddenTaskLauncher(bootstrap,root),{flag:'wx'});
  const hidden=taskAction(bootstrap),executable=hidden.execute;
  // S4U runs without an interactive desktop and needs no stored plaintext password.
  const code=`$ErrorActionPreference='Stop';$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;$action=New-ScheduledTaskAction -Execute ${psQuote(executable)} -Argument ${psQuote(hidden.arguments)} -WorkingDirectory ${psQuote(bootstrap)};$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited;$triggers=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -AtLogOn -User $user));$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1);if(Get-ScheduledTask -TaskName ${psQuote(setting.taskName)} -ErrorAction SilentlyContinue){throw 'Task already exists; no overwrite authorized by this command'};Register-ScheduledTask -TaskName ${psQuote(setting.taskName)} -Action $action -Principal $principal -Trigger $triggers -Settings $settings -Description 'Sense approved immutable staging release; guarded retained database startup'|Out-Null;Get-ScheduledTask -TaskName ${psQuote(setting.taskName)}|Select-Object TaskName,State,@{n='LogonType';e={$_.Principal.LogonType}},@{n='UserId';e={$_.Principal.UserId}}|ConvertTo-Json -Compress`;
  const result=powershell(code);atomicJson(path.join(bootstrap,'installation.json'),{at:new Date().toISOString(),commit:active.manifest.commit,hashes:Object.fromEntries(['bootstrap.mjs','manifest.mjs','node.exe'].map(file=>[file,fileHash(path.join(bootstrap,file))])),task:JSON.parse(result)});console.log(result);
} else if(command==='refresh-startup-launcher') {
  const bootstrap=scoped(root,'.env.staging/bootstrap'),action=taskAction(bootstrap),script=path.join(bootstrap,'launch-hidden.ps1');
  const task=JSON.parse(powershell(`$t=Get-ScheduledTask -TaskName ${psQuote(setting.taskName)};[pscustomobject]@{State=[string]$t.State;Execute=$t.Actions.Execute;Arguments=$t.Actions.Arguments}|ConvertTo-Json -Compress`));
  assert.notEqual(task.State,'Running','Stop the verified owned app before updating its launcher');
  const original=task.Execute===path.join(bootstrap,'node.exe') && task.Arguments==='"'+path.join(bootstrap,'bootstrap.mjs')+'" "'+root+'"';
  const priorHidden=task.Execute===action.execute && task.Arguments===action.arguments.replace(' -ExecutionPolicy RemoteSigned','');
  assert.ok(original || priorHidden || (task.Execute===action.execute && task.Arguments===action.arguments),'Scheduled task action differs; refusing replacement');
  assert.equal(listeners([59442,59443]).length,0,'Canonical app must be stopped');
  const backup=path.join(bootstrap,'task-preserved-'+Date.now()+'.xml');
  fs.writeFileSync(backup,powershell(`Export-ScheduledTask -TaskName ${psQuote(setting.taskName)}`),{flag:'wx'});
  if(fs.existsSync(script))fs.copyFileSync(script,script+'.preserved-'+Date.now(),fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(script,hiddenTaskLauncher(bootstrap,root));
  powershell(`$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName ${psQuote(setting.taskName)};if(@($t.Actions).Count -ne 1 -or $t.State -eq 'Running' -or $t.Actions.Execute -cne ${psQuote(task.Execute)} -or $t.Actions.Arguments -cne ${psQuote(task.Arguments)}){throw 'Task changed before update'};$before=$t|Select-Object Principal,Triggers,Settings|ConvertTo-Json -Depth 10 -Compress;$action=New-ScheduledTaskAction -Execute ${psQuote(action.execute)} -Argument ${psQuote(action.arguments)} -WorkingDirectory ${psQuote(bootstrap)};Set-ScheduledTask -TaskName ${psQuote(setting.taskName)} -Action $action|Out-Null;$after=Get-ScheduledTask -TaskName ${psQuote(setting.taskName)}|Select-Object Principal,Triggers,Settings|ConvertTo-Json -Depth 10 -Compress;if($before -cne $after){throw 'Task principal/triggers/settings changed'};[pscustomobject]@{Before=$before;After=$after}|ConvertTo-Json -Compress|Set-Content -LiteralPath ${psQuote(backup+'.settings.json')}`);
  console.log(JSON.stringify({updated:'hidden scheduled launcher',backup,...action,sha256:fileHash(script)}));
} else if(command==='restart') {
  for(const action of ['stop','start'])execFileSync(process.execPath,[fileURLToPath(import.meta.url),action],{stdio:'inherit',windowsHide:true});
} else if(command==='start') {
  const bootstrap=scoped(root,'.env.staging/bootstrap'),action=taskAction(bootstrap),script=path.join(bootstrap,'launch-hidden.ps1');
  powershell(`$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName ${psQuote(setting.taskName)};$original=$t.Actions.Execute -ceq ${psQuote(path.join(bootstrap,'node.exe'))} -and $t.Actions.Arguments -ceq ${psQuote('"'+path.join(bootstrap,'bootstrap.mjs')+'" "'+root+'"')};$hidden=$t.Actions.Execute -ceq ${psQuote(action.execute)} -and $t.Actions.Arguments -ceq ${psQuote(action.arguments)} -and (Test-Path -LiteralPath ${psQuote(script)}) -and (Get-Content -Raw -LiteralPath ${psQuote(script)}) -ceq ${psQuote(hiddenTaskLauncher(bootstrap,root))};if(@($t.Actions).Count -ne 1 -or (-not ($original -or $hidden)) -or $t.Actions.WorkingDirectory -cne ${psQuote(bootstrap)}){throw 'Scheduled task action or launcher changed; refusing start'};Start-ScheduledTask -TaskName ${psQuote(setting.taskName)}`);
  let failure;for(let i=0;i<40;i++){await pause(2000);try{console.log(JSON.stringify(await status(),null,2));failure=null;break;}catch(error){failure=error;}}
  if(failure)throw failure;
} else if(command==='stop') {
  const state=JSON.parse(fs.readFileSync(scoped(root,setting.runtimeState)));
  assert.ok(sameIdentity(processIdentity(state.supervisor.ProcessId),state.supervisor),'No verified owned supervisor');
  atomicJson(path.join(scoped(root,setting.controlRoot),'request.json'),{command:'stop',token:state.token,at:new Date().toISOString()});
  for(let i=0;i<80;i++){await pause(1000);if(!sameIdentity(processIdentity(state.supervisor.ProcessId),state.supervisor))break;if(i===79)throw new Error('Owned stop timed out');}
  assert.equal(listeners([59442,59443]).length,0,'App listeners remain after stop');
  // IgnoreNew must not swallow a restart while the old bootstrap is still exiting.
  for(let i=0;i<20;i++){
    const task=JSON.parse(powershell(`$t=Get-ScheduledTask -TaskName ${psQuote(setting.taskName)};[pscustomobject]@{State=[string]$t.State;Execute=$t.Actions.Execute;Arguments=$t.Actions.Arguments}|ConvertTo-Json -Compress`));
    const bootstrap=scoped(root,'.env.staging/bootstrap'),hidden=taskAction(bootstrap);
    const original=task.Execute===path.join(bootstrap,'node.exe') && task.Arguments==='"'+path.join(bootstrap,'bootstrap.mjs')+'" "'+root+'"';
    assert.ok(original || (task.Execute===hidden.execute && task.Arguments===hidden.arguments && fs.readFileSync(path.join(bootstrap,'launch-hidden.ps1'),'utf8')===hiddenTaskLauncher(bootstrap,root)),'Scheduled task action differs');
    if(task.State!=='Running')break;if(i===19)throw new Error('Owned scheduled bootstrap did not stop');await pause(500);
  }
  console.log('Owned app stopped; retained database and artifacts preserved.');
} else throw new Error('Use status | promote <40-char-commit> <acceptance.json> | install-startup | start | stop | restart');
