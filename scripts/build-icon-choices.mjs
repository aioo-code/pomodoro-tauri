import { mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, env } from './environment.mjs';
const styles=[['flow','番茄'],['orbit','星轨'],['bloom','花语'],['prism','棱镜'],['graphite','曜黑']];
const output=path.join(root,'src-tauri/icons/choices');mkdirSync(output,{recursive:true});
cpSync(path.join(root,'app-icon.svg'),path.join(root,'frontend/assets/icons/flow.svg'));
const manifest=[];
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function run(file,args){const result=spawnSync(file,args,{cwd:root,env,windowsHide:true,encoding:'utf8'});if(result.error)throw result.error;if(result.status!==0)throw Error(result.stderr||result.stdout);}
for(const[id,label]of styles){
 const svg=path.join(root,'frontend/assets/icons',id+'.svg'),temporary=path.join(root,'tmp/icon-choices',id);
 run(process.execPath,[path.join(root,'node_modules/@tauri-apps/cli/tauri.js'),'icon',svg,'--output',temporary]);
 const assets={};
 for(const size of[32,128]){const png=path.join(temporary,`${size}x${size}.png`),rgba=path.join(output,`${id}-${size}.rgba`);cpSync(png,path.join(output,`${id}-${size}.png`));run('pwsh',['-NoProfile','-File',path.join(root,'scripts/export-icon-rgba.ps1'),'-Png',png,'-Output',rgba]);if(readFileSync(rgba).length!==size*size*4)throw Error('Invalid RGBA size');assets[size]={file:path.basename(rgba),sha256:hash(rgba)};}
 manifest.push({id,label,sourceSha256:hash(svg),assets});
}
writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest.map(({id,label,assets})=>({id,label,sha256:assets[128].sha256}))));
