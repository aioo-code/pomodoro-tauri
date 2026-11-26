import {noiseSamples,type NoiseTexture} from './audio-dsp';

const scope=globalThis as unknown as {
  onmessage:((event:MessageEvent<{texture:NoiseTexture}>)=>void)|null;
  postMessage:(message:unknown,transfer?:Transferable[])=>void;
};
scope.onmessage=event=>{
  try {
    const channels=noiseSamples(event.data.texture);
    scope.postMessage({channels},channels.map(channel=>channel.buffer as ArrayBuffer));
  } catch(error) { scope.postMessage({error:String(error)}); }
};
