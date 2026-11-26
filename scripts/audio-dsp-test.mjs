import {stripTypeScriptTypes} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {root} from './environment.mjs';
const source=readFileSync(path.join(root,'frontend/lib/audio-dsp.ts'),'utf8');
const dsp=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64'));
const output=path.join(root,'tmp/meditation-palette');mkdirSync(output,{recursive:true});
function metrics(data){let mean=0,power=0,peak=0,delta=0;for(let i=0;i<data.length;i++){assert.ok(Number.isFinite(data[i]));mean+=data[i];power+=data[i]**2;peak=Math.max(peak,Math.abs(data[i]));if(i)delta+=(data[i]-data[i-1])**2;}return{mean:mean/data.length,rms:Math.sqrt(power/data.length),peak,derivative:Math.sqrt(delta/(data.length-1)),boundary:Math.abs(data[0]-data.at(-1))};}
function wav(name,channels,rate,gain){const n=channels[0].length,out=Buffer.alloc(44+n*channels.length*2);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(channels.length,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*channels.length*2,28);out.writeUInt16LE(channels.length*2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(out.length-44,40);for(let i=0;i<n;i++)for(let c=0;c<channels.length;c++){const fade=Math.min(1,i/(rate*.3),(n-1-i)/(rate*.4));out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,channels[c][i]*gain*fade))*32767),44+(i*channels.length+c)*2);}writeFileSync(path.join(output,name+'.wav'),out);}
const textures={};
for(const kind of['still','space','bowl']){const channels=dsp.noiseSamples(kind);textures[kind]=channels.map(metrics);for(const m of textures[kind]){assert.ok(Math.abs(m.mean)<1e-6);assert.ok(m.rms>.09&&m.rms<=.141);assert.ok(m.peak<=.601);assert.ok(m.boundary<Math.max(.02,m.derivative*4));}assert.notDeepEqual(channels[0],channels[1]);wav(kind,channels.map(c=>c.slice(0,24000*8)),24000,dsp.noiseGain(40)*.8);}
function linePower(data,hz){const frequency=Math.round(hz*24)/24,c=2*Math.cos(2*Math.PI*frequency/24000);let a=0,b=0;for(const sample of data){const next=sample+c*a-b;b=a;a=next;}return Math.max(0,2*(a*a+b*b-c*a*b)/data.length**2);}
const tonalShares={};
for(const [kind,hz]of Object.entries({still:[110,110.083,164.814,220,277.183,329.628],space:[110,220,329.628,440,554.365,659.255,880],bowl:[110,164.814,220,329.628]})){
 const [left,right]=dsp.noiseSamples(kind);assert.equal(left.length,24000*24);let energy=0,cross=0,stereo=0;for(let i=0;i<left.length;i++){energy+=left[i]**2;stereo+=right[i]**2;cross+=left[i]*right[i];}
 tonalShares[kind]=hz.reduce((sum,f)=>sum+linePower(left,f),0)/(energy/left.length);
 assert.ok(tonalShares[kind]>(kind==='bowl'?.3:.6),'Predominantly tonal meditation, not broadband noise: '+kind);
 assert.ok(cross/Math.sqrt(energy*stereo)>.5,'Compatible stereo/mono: '+kind);
 assert.ok(textures[kind][0].derivative<.04,'No sharp noise transients: '+kind);
}
const cues={},sequence=new Float32Array(32000*5);let cursor=0;
for(const kind of['select','start','pause','reset','complete','dismiss']){const data=dsp.cueSamples(kind);cues[kind]=metrics(data);assert.equal(data[0],0);assert.equal(data.at(-1),0);assert.ok(cues[kind].peak<.5&&cues[kind].peak>.05);assert.ok(data.length<32000*1.2);sequence.set(data,cursor);cursor+=data.length+Math.round(32000*.3);}
wav('interaction-palette',[sequence.slice(0,cursor)],32000,dsp.cueGain(65)*.8);
assert.equal(dsp.noiseGain(0),0);assert.equal(dsp.cueGain(0),0);assert.equal(dsp.noiseGain(101),dsp.noiseGain(100));
const result={passed:true,sourceSha256:createHash('sha256').update(source).digest('hex'),textures,tonalShares,cues,output};writeFileSync(path.join(output,'dsp-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,output,textures}));
