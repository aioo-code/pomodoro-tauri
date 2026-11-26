import {readFileSync,writeFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root} from './environment.mjs';
const code=stripTypeScriptTypes(readFileSync(path.join(root,'frontend/lib/drag-queue.ts'),'utf8'),{mode:'transform'});
const {DragQueue}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const frame=(sequence,finish=false,gesture='first')=>({gesture,sequence,startX:0,startY:0,x:sequence,y:0,finish,cancelled:false});
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
const errors=[];
{
 const blocked=gate(),sent=[];let concurrent=0,peak=0;
 const queue=new DragQueue(async value=>{peak=Math.max(peak,++concurrent);sent.push(value);if(sent.length===1)await blocked.promise;concurrent--;},error=>errors.push(String(error)));
 queue.push(frame(1));for(let i=2;i<=1000;i++)queue.push(frame(i));blocked.release();await queue.whenIdle();
 assert.deepEqual(sent.map(p=>p.sequence),[1,1000]);assert.equal(peak,1);
}
{
 const blocked=gate(),sent=[];
 const queue=new DragQueue(async value=>{sent.push(value);if(sent.length===1)await blocked.promise;},error=>errors.push(String(error)));
 queue.push(frame(1));queue.push(frame(2));queue.push(frame(3,true));queue.push(frame(1,false,'second'));queue.push(frame(2,true,'second'));
 blocked.release();await queue.whenIdle();assert.deepEqual(sent.map(p=>[p.gesture,p.sequence,p.finish]),[['first',1,false],['first',3,true],['second',2,true]]);
}
{
 const sent=[],failures=[];
 const queue=new DragQueue(async value=>{sent.push(value);if(value.sequence===1)throw Error('isolated test failure');},error=>failures.push(String(error)));
 queue.push(frame(1));queue.push({...frame(2,true),cancelled:true});await queue.whenIdle();assert.equal(sent[1].cancelled,true);assert.equal(failures.length,1);
 queue.push(frame(3,true,'next'));await queue.whenIdle();assert.equal(sent.at(-1).gesture,'next');
}
assert.deepEqual(errors,[]);
const result={passed:true,sourceSha256:createHash('sha256').update(readFileSync(path.join(root,'frontend/lib/drag-queue.ts'))).digest('hex'),checks:['1000 delayed moves coalesce to the latest position with one request in flight','release coordinates and successive gesture ordering survive a stalled acknowledgement','cancel/error paths release the queue and the next gesture works']};
writeFileSync(path.join(root,'tmp/drag-queue-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
