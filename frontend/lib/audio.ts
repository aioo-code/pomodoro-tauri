import {cueSamples,noiseSamples,cueGain,noiseGain,type Cue,type NoiseTexture} from './audio-dsp';
import {getCustomSound,subscribeCustomSoundChanges} from './custom-sounds';

export type NoiseSelection=NoiseTexture|`custom:${string}`;
export interface AudioPreferences {audioMuted:boolean;interactionSounds:boolean;interactionVolume:number;reminderNoise:boolean;noiseTexture:NoiseTexture;customNoiseId:string;noiseVolume:number}
const defaults: AudioPreferences={audioMuted:false,interactionSounds:true,interactionVolume:28,reminderNoise:true,noiseTexture:'still',customNoiseId:'',noiseVolume:22};
interface Noise {source:AudioBufferSourceNode|MediaElementAudioSourceNode;gain:GainNode;texture:NoiseSelection;preview:boolean;version:number;media?:HTMLAudioElement;url?:string;stopTimer?:ReturnType<typeof setTimeout>;endAt?:number;disposed?:boolean}
interface State {playing:boolean;preview:boolean;texture:NoiseSelection;status:'idle'|'loading'|'playing'|'blocked'|'unavailable'}
class MissingCustomSound extends Error {}
let values=defaults,context:AudioContext|undefined,mix:GainNode|undefined,output:GainNode|undefined,deviceOutput:GainNode|undefined,analyser:AnalyserNode|undefined,noise:Noise|undefined,version=0;
let current:State={playing:false,preview:false,texture:'still',status:'idle'};
const listeners=new Set<()=>void>(),cache=new Map<string,AudioBuffer>(),sources=new Set<AudioBufferSourceNode>(),handles=new Set<Noise>();
const synthesis=new Map<NoiseTexture,Promise<AudioBuffer>>(),workers=new Map<Worker,()=>void>();
let pendingPlayback:{texture:NoiseSelection;preview:boolean;version:number;cancel:()=>void}|undefined;
const instance=crypto.randomUUID();let channel:BroadcastChannel|undefined,lastCue=0,cueVersion=0,idleTimer:ReturnType<typeof setTimeout>|undefined;
declare global {interface Window {__POMODORO_SILENT_AUDIO__?:boolean;__POMODORO_AUDIO__?:{snapshot:typeof audioSnapshot;preview:typeof audioPreview}}}
function publish(state: Partial<State>) {current={...current,...state};listeners.forEach(callback=>callback());}
export const subscribeAudio=(callback:()=>void)=>{listeners.add(callback);return()=>{listeners.delete(callback);};};
export const audioState=()=>current;
function smooth(gain:AudioParam,target:number,seconds=.15){if(!context)return;const now=context.currentTime;gain.cancelAndHoldAtTime(now);gain.linearRampToValueAtTime(target,now+seconds);}
function graph():AudioContext {
  if(context?.state==='closed'){context=undefined;cache.clear();channel?.close();}
  if(context)return context;
  context=new AudioContext({latencyHint:'interactive'});
  mix=context.createGain();const compressor=context.createDynamicsCompressor();compressor.threshold.value=-16;compressor.knee.value=12;compressor.ratio.value=3;
  analyser=context.createAnalyser();analyser.fftSize=1024;output=context.createGain();output.gain.value=values.audioMuted?0:.8;
  // Keep the hardware-silent QA guard separate from the real master mute fade.
  deviceOutput=context.createGain();deviceOutput.gain.value=window.__POMODORO_SILENT_AUDIO__?0:1;
  mix.connect(compressor);compressor.connect(analyser);analyser.connect(output);output.connect(deviceOutput);deviceOutput.connect(context.destination);
  if(typeof BroadcastChannel!=='undefined'){
    channel=new BroadcastChannel('pomodoro-ambient-audio');
    channel.onmessage=event=>{if(event.data?.kind==='noise-started'&&event.data?.instance!==instance)void stopNoise(.18);};
  }
  return context;
}
export async function unlockAudio(){try{const ctx=graph();if(ctx.state==='suspended')await Promise.race([ctx.resume(),new Promise(resolve=>setTimeout(resolve,700))]);suspendWhenIdle(1000);return ctx.state==='running';}catch{publish({status:'unavailable'});return false;}}
function buffer(kind:Cue|NoiseTexture,ambient:boolean){const ctx=graph(),key=(ambient?'noise:':'cue:')+kind;let existing=cache.get(key);if(existing)return existing;
  const rate=ambient?24000:32000,samples=ambient?noiseSamples(kind as NoiseTexture):[cueSamples(kind as Cue)];
  existing=ctx.createBuffer(samples.length,samples[0].length,rate);samples.forEach((data,index)=>existing!.getChannelData(index).set(data));cache.set(key,existing);return existing;
}
function ambientBuffer(texture:NoiseTexture):Promise<AudioBuffer> {
  const cached=cache.get('noise:'+texture);if(cached)return Promise.resolve(cached);
  const pending=synthesis.get(texture);if(pending)return pending;
  const ctx=graph();
  const task=new Promise<AudioBuffer>((resolve,reject)=>{
    const worker=new Worker(new URL('./audio-worker.ts',import.meta.url),{type:'module'});
    let timeout:ReturnType<typeof setTimeout>;
    const cleanup=()=>{clearTimeout(timeout);workers.delete(worker);worker.terminate();};
    workers.set(worker,()=>{cleanup();reject(new Error('Audio synthesis cancelled'));});
    timeout=setTimeout(()=>{cleanup();reject(new Error('Audio synthesis timed out'));},20000);
    worker.onerror=event=>{event.preventDefault();cleanup();reject(new Error('Audio synthesis unavailable'));};
    worker.onmessage=(event:MessageEvent<{channels?:Float32Array[];error?:string}>)=>{
      cleanup();
      try {
        if(event.data.error||!event.data.channels||ctx.state==='closed')throw new Error(event.data.error??'Audio context closed');
        const channels=event.data.channels,result=ctx.createBuffer(channels.length,channels[0].length,24000);
        channels.forEach((data,index)=>result.getChannelData(index).set(data));cache.set('noise:'+texture,result);resolve(result);
      } catch(error) {reject(error);}
    };
    worker.postMessage({texture});
  }).finally(()=>{synthesis.delete(texture);});
  synthesis.set(texture,task);return task;
}
function suspendWhenIdle(delay=700){clearTimeout(idleTimer);idleTimer=setTimeout(()=>{if(!handles.size&&!pendingPlayback&&!sources.size&&context?.state==='running')void context.suspend().catch(()=>{});},delay);}
export function selectedNoise(preferences:Pick<AudioPreferences,'noiseTexture'|'customNoiseId'>=values):NoiseSelection{return preferences.customNoiseId?`custom:${preferences.customNoiseId}`:preferences.noiseTexture;}
function disposeNoise(active:Noise){
  if(active.disposed)return;active.disposed=true;clearTimeout(active.stopTimer);handles.delete(active);
  if(active.media){active.media.onended=null;active.media.onerror=null;active.media.pause();active.media.removeAttribute('src');active.media.load();if(active.url)URL.revokeObjectURL(active.url);}
  else (active.source as AudioBufferSourceNode).onended=null;
  active.source.disconnect();active.gain.disconnect();
  if(noise===active){noise=undefined;publish({playing:false,preview:false,status:'idle'});}
  suspendWhenIdle();
}
function scheduleEnd(active:Noise,at:number){
  if(!context||active.disposed)return;
  if(active.media){clearTimeout(active.stopTimer);active.stopTimer=setTimeout(()=>disposeNoise(active),Math.max(0,at-context.currentTime)*1000);}
  else try{(active.source as AudioBufferSourceNode).stop(at);}catch{disposeNoise(active);}
}
function retireNoise(active:Noise,fade:number){
  if(!context||active.disposed){disposeNoise(active);return;}
  smooth(active.gain.gain,0,fade);
  if(fade===0){if(!active.media)try{(active.source as AudioBufferSourceNode).stop();}catch{}disposeNoise(active);}
  else scheduleEnd(active,context.currentTime+fade+.025);
}
async function customHandle(texture:`custom:${string}`,preview:boolean,request:number,signal:AbortSignal):Promise<Noise>{
  const record=await getCustomSound(texture.slice(7));
  if(signal.aborted)throw new DOMException('Cancelled','AbortError');
  if(!record)throw new MissingCustomSound('Custom sound unavailable');
  const ctx=graph(),media=new Audio(),gain=ctx.createGain(),url=URL.createObjectURL(record.blob);
  gain.gain.value=0;media.loop=true;media.preload='auto';
  // A media source is connected before play, so every sample uses the same master,
  // analyser, compressor and hardware-silent guard as the procedural sound palette.
  let source:MediaElementAudioSourceNode;
  try{source=ctx.createMediaElementSource(media);source.connect(gain);gain.connect(mix!);}
  catch(error){gain.disconnect();URL.revokeObjectURL(url);throw error;}
  const active:Noise={source,gain,texture,preview,version:request,media,url};handles.add(active);
  const cancel=()=>disposeNoise(active);signal.addEventListener('abort',cancel,{once:true});
  try{
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>finish(new Error('Custom sound loading timed out')),15000);
      const abort=()=>finish(new DOMException('Cancelled','AbortError'));
      const finish=(error?:unknown)=>{clearTimeout(timeout);media.oncanplay=null;media.onerror=null;signal.removeEventListener('abort',abort);if(error)reject(error);else resolve();};
      media.oncanplay=()=>finish();media.onerror=()=>finish(new Error('Custom sound cannot be played'));
      signal.addEventListener('abort',abort,{once:true});media.src=url;media.load();
      if(signal.aborted)abort();
    });
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    await media.play();
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    media.onerror=()=>{const wasCurrent=noise===active;disposeNoise(active);if(wasCurrent)publish({status:'unavailable'});};
    return active;
  }catch(error){disposeNoise(active);throw error;}
  finally{signal.removeEventListener('abort',cancel);}
}
export function configureAudio(next:AudioPreferences){
  const previous=values;values={...defaults,...next};
  if(output&&previous.audioMuted!==values.audioMuted)smooth(output.gain,values.audioMuted?0:.8,.08);
  if((previous.interactionSounds&&!values.interactionSounds)||values.interactionVolume===0||values.audioMuted){cueVersion++;for(const source of sources)try{source.stop();}catch{}}
  if(values.audioMuted&&(noise?.preview||pendingPlayback?.preview))void stopNoise(.08);
  const active=pendingPlayback??noise;
  if(active){
    if(!active.preview&&previous.reminderNoise&&!values.reminderNoise)void stopNoise(.2);
    else if(selectedNoise(previous)!==selectedNoise(values))void playNoise(undefined,active.preview);
    else if(previous.noiseVolume!==values.noiseVolume)previewVolume(values.noiseVolume);
  }
}
export async function playCue(kind:Cue,force=false){if(values.audioMuted||(!force&&!values.interactionSounds)||values.interactionVolume===0)return;
  const now=performance.now();if(kind==='select'&&now-lastCue<65)return;lastCue=now;
  const request=cueVersion;
  if(!await unlockAudio()||request!==cueVersion||values.audioMuted||(!force&&!values.interactionSounds))return;
  const ctx=graph(),source=ctx.createBufferSource(),gain=ctx.createGain();source.buffer=buffer(kind,false);gain.gain.value=cueGain(values.interactionVolume);source.connect(gain);gain.connect(mix!);sources.add(source);
  source.onended=()=>{sources.delete(source);source.disconnect();gain.disconnect();suspendWhenIdle();};source.start();
}
export async function playNoise(texture:NoiseSelection=selectedNoise(),preview=false):Promise<boolean>{
  pendingPlayback?.cancel();
  const request=++version,controller=new AbortController();pendingPlayback={texture,preview,version:request,cancel:()=>controller.abort()};publish({status:'loading',preview,texture});
  if(!await unlockAudio()){if(request===version){pendingPlayback=undefined;publish({status:'blocked',playing:!!noise,preview:noise?.preview??false});suspendWhenIdle();}return false;}
  if(request!==version)return false;
  let active:Noise;
  try {
    if(texture.startsWith('custom:'))active=await customHandle(texture as `custom:${string}`,preview,request,controller.signal);
    else{
      const samples=await ambientBuffer(texture as NoiseTexture);
      if(request!==version)return false;
      const ctx=graph(),source=ctx.createBufferSource(),gain=ctx.createGain();
      source.buffer=samples;source.loop=true;gain.gain.value=0;source.connect(gain);gain.connect(mix!);
      active={source,gain,texture,preview,version:request};handles.add(active);
      source.onended=()=>disposeNoise(active);source.start();
    }
  }catch(error){
    if(request===version&&error instanceof MissingCustomSound)return playNoise(values.noiseTexture,preview);
    if(request===version){pendingPlayback=undefined;publish({status:error instanceof DOMException&&error.name==='NotAllowedError'?'blocked':'unavailable',playing:!!noise,preview:noise?.preview??false,texture:noise?.texture??texture});suspendWhenIdle();}
    return false;
  }
  if(request!==version){retireNoise(active,0);return false;}
  pendingPlayback=undefined;
  const ctx=graph(),old=noise,gain=active.gain;noise=active;
  if(old)retireNoise(old,.45);
  const now=ctx.currentTime,target=noiseGain(values.noiseVolume);gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(target,now+(preview ? .65 : 2.4));
  if(preview){active.endAt=now+8.35;gain.gain.setValueAtTime(target,now+7.8);gain.gain.linearRampToValueAtTime(0,now+8.3);scheduleEnd(active,active.endAt);}
  channel?.postMessage({kind:'noise-started',instance});publish({playing:true,preview,texture,status:'playing'});return true;
}
export async function stopNoise(fade=.18){version++;pendingPlayback?.cancel();pendingPlayback=undefined;const active=noise;noise=undefined;if(active)retireNoise(active,fade);
  publish({playing:false,preview:false,status:'idle'});suspendWhenIdle((fade+.08)*1000);if(fade>0)await new Promise(resolve=>setTimeout(resolve,fade*1000));
}
export function previewVolume(volume:number){if(noise&&context){smooth(noise.gain.gain,noiseGain(volume),.06);if(noise.endAt&&noise.endAt>context.currentTime+.15){noise.gain.gain.setValueAtTime(noiseGain(volume),Math.max(context.currentTime+.06,noise.endAt-.55));noise.gain.gain.linearRampToValueAtTime(0,noise.endAt-.03);}}}
export function audioSnapshot(){const samples=new Float32Array(analyser?.fftSize??0);analyser?.getFloatTimeDomainData(samples);let sum=0,peak=0;for(const value of samples){sum+=value*value;peak=Math.max(peak,Math.abs(value));}
  return {...current,muted:values.audioMuted,context:context?.state??'absent',sampleRate:context?.sampleRate??0,noiseGain:noise?.gain.gain.value??0,masterGain:output?.gain.value??0,deviceGain:deviceOutput?.gain.value??0,outputGain:(output?.gain.value??0)*(deviceOutput?.gain.value??0),cueSources:sources.size,mediaSources:[...handles].filter(handle=>!!handle.media).length,synthesisWorkers:workers.size,pendingTexture:pendingPlayback?.texture??null,peak,rms:samples.length?Math.sqrt(sum/samples.length):0};
}
async function audioPreview(kind:Cue|NoiseTexture,ambient:boolean,volume:number){const rate=ambient?24000:32000,channels=ambient?noiseSamples(kind as NoiseTexture):[cueSamples(kind as Cue)],gain=(ambient?noiseGain:cueGain)(volume)*.8;return {sampleRate:rate,channels:channels.map(channel=>Array.from(channel,value=>value*gain))};}
if(typeof window!=='undefined'){
  window.addEventListener('pointerdown',()=>{if(values.interactionSounds&&!values.audioMuted)void unlockAudio();},{capture:true});
  window.addEventListener('keydown',event=>{if(values.interactionSounds&&!values.audioMuted&&['Enter',' ','ArrowLeft','ArrowRight'].includes(event.key))void unlockAudio();},{capture:true});
  window.addEventListener('pagehide',()=>{void stopNoise(0);for(const handle of handles)retireNoise(handle,0);for(const cancel of workers.values())cancel();channel?.close();clearTimeout(idleTimer);void context?.close().catch(()=>{});});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(noise?.preview||pendingPlayback?.preview))void stopNoise(.15);});
  if(window.__POMODORO_SILENT_AUDIO__)window.__POMODORO_AUDIO__={snapshot:audioSnapshot,preview:audioPreview};
}
subscribeCustomSoundChanges(change=>{
  if(change.kind!=='removed')return;
  const active=pendingPlayback??noise;
  if(active?.texture===`custom:${change.id}`){if(active.preview)void stopNoise(.15);else void playNoise(values.noiseTexture);}
});
