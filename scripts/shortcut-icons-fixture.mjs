import {mkdirSync,writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
export function verifyShortcutIcons({run,helper,icon,program,version}){
 const area=path.join(run,'shortcut-icons'),installation=path.join(area,'安装 位置'),links=path.join(area,'links');mkdirSync(installation,{recursive:true});mkdirSync(links,{recursive:true});
 const exe=path.join(installation,'pomodoro-connected.exe'),versionIcon=path.join(installation,`pomodoro-app-icon-${version}.ico`);copyFileSync(program,exe);copyFileSync(icon,versionIcon);
 const launcher=path.join(installation,'start.ps1');writeFileSync(launcher,'fixture only; never execute');
 const shell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
 function ps(code,extra={}){const r=spawnSync('pwsh',['-NoProfile','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'+code],{windowsHide:true,encoding:'utf8',env:{...process.env,...extra},timeout:30000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
 const spec=path.join(area,'links.json'),owned=[{path:path.join(links,'Desktop.lnk'),target:exe,args:'--keep-sentinel',icon:exe+',0'},{path:path.join(links,'Programs.lnk'),target:shell,args:`-NoProfile -File "${launcher}"`,icon:exe+',0'}];
 writeFileSync(spec,JSON.stringify(owned));
 ps("$taskShell=New-Object -ComObject WScript.Shell;foreach($taskRow in (Get-Content -LiteralPath $env:POM_SPEC -Encoding UTF8 -Raw|ConvertFrom-Json)){$taskLink=$taskShell.CreateShortcut($taskRow.path);$taskLink.TargetPath=$taskRow.target;$taskLink.Arguments=$taskRow.args;$taskLink.WorkingDirectory=$env:POM_ROOT;$taskLink.IconLocation=$taskRow.icon;$taskLink.Description='preserve fixture';$taskLink.Save()}",{POM_SPEC:spec,POM_ROOT:installation});
 const inspect=()=>JSON.parse(ps("$taskShell=New-Object -ComObject WScript.Shell;$taskRows=@();foreach($taskRow in (Get-Content -LiteralPath $env:POM_SPEC -Encoding UTF8 -Raw|ConvertFrom-Json)){$taskLink=$taskShell.CreateShortcut($taskRow.path);$taskRows+=@{path=$taskRow.path;target=$taskLink.TargetPath;args=$taskLink.Arguments;working=$taskLink.WorkingDirectory;description=$taskLink.Description;icon=$taskLink.IconLocation}};ConvertTo-Json -InputObject @($taskRows)",{POM_SPEC:spec}));
 const before=inspect();
 function refresh(directory){const r=spawnSync(shell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',helper,'-InstallDirectory',installation,'-IconPath',versionIcon,'-ShortcutDirectory',directory],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
 const applied=refresh(links);assert.equal(applied.changed.length,2,JSON.stringify(applied));const after=inspect();for(let i=0;i<after.length;i++){const {icon:oldIcon,...old}=before[i],{icon:newIcon,...current}=after[i];assert.deepEqual(current,old);assert.equal(newIcon,versionIcon+',0');}
 const saved=owned.map(x=>hash(x.path)),again=refresh(links);assert.equal(again.changed.length,0);assert.deepEqual(owned.map(x=>hash(x.path)),saved);
 const customIcon=path.join(area,'personal.ico');copyFileSync(icon,customIcon);const foreign=path.join(area,'other.exe');copyFileSync(program,foreign);
 const custom=[{...owned[0],icon:customIcon+',0'},{...owned[1],target:foreign,args:'--foreign',icon:''}];writeFileSync(spec,JSON.stringify(custom));
 ps("$taskShell=New-Object -ComObject WScript.Shell;foreach($taskRow in (Get-Content -LiteralPath $env:POM_SPEC -Encoding UTF8 -Raw|ConvertFrom-Json)){$taskLink=$taskShell.CreateShortcut($taskRow.path);$taskLink.TargetPath=$taskRow.target;$taskLink.Arguments=$taskRow.args;$taskLink.IconLocation=$taskRow.icon;$taskLink.Save()}",{POM_SPEC:spec});
 const customBefore=inspect(),skipped=refresh(links);assert.equal(skipped.changed.length,0);assert.equal(skipped.skipped.length,2);assert.deepEqual(inspect(),customBefore);
 const result={passed:true,version,programSha256:hash(program),helperSha256:hash(helper),versionIconSha256:hash(versionIcon),applied,again,skipped,personalIconsPreserved:true,launchDetailsPreserved:true,hostProfileTouched:false,run:area};writeFileSync(path.join(area,'result.json'),JSON.stringify(result,null,2));return result;
}
