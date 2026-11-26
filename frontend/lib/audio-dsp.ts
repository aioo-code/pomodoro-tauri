// Original procedural sound palette. No recordings, network or third-party samples.
// The persisted noiseTexture field is retained for compatibility with older releases.
export type NoiseTexture = 'still' | 'space' | 'bowl';
export type Cue = 'select' | 'start' | 'pause' | 'reset' | 'complete' | 'dismiss';
export const noiseTextures: {id: NoiseTexture; label: string; detail: string}[] = [
  {id:'still',label:'静心',detail:'温暖和弦，缓慢起伏'},
  {id:'space',label:'空灵',detail:'轻盈泛音，通透留白'},
  {id:'bowl',label:'颂钵',detail:'柔和共鸣，悠长余韵'},
];
export function noiseGain(volume: number) {return .65*Math.pow(Math.min(100,Math.max(0,volume))/100,1.5);}
export function cueGain(volume: number) {return .34*Math.pow(Math.min(100,Math.max(0,volume))/100,1.3);}

export function noiseSamples(kind: NoiseTexture, sampleRate=24000, seconds=24): Float32Array[] {
  const count=Math.round(sampleRate*seconds),period=count/sampleRate,tau=2*Math.PI;
  // Quantized carrier cycles and periodic envelopes make the complete harmony
  // seamless, including the resonant tails crossing the loop boundary.
  const frequency=(hz:number)=>Math.round(hz*period)/period;
  const pad=kind==='still'
    ? [[110,.42],[110.083,.09],[164.814,.2],[220,.13],[277.183,.07],[329.628,.045]]
    : [[110,.12],[220,.22],[329.628,.2],[440,.13],[554.365,.07],[659.255,.045],[880,.025]];
  const voices=pad.map(([hz,level],index)=>({step:tau*frequency(hz)/sampleRate,level,cycles:1+index%3,phase:index*.79}));
  const bowls=[220,329.628,164.814].map((hz,index)=>({offset:period*(index/3+.045),partials:[1,2.706,4.041,5.42].map((ratio,i)=>({step:tau*frequency(hz*ratio)/sampleRate,level:[.4,.105,.04,.015][i]}))}));
  return [0,1].map(channel => {
    const samples=new Float32Array(count);
    for(let i=0;i<count;i++){
      const t=i/sampleRate,phase=tau*i/count;let value=0;
      if(kind==='bowl'){
        value=.035*Math.sin(tau*frequency(110)*t)+.02*Math.sin(tau*frequency(164.814)*t);
        for(const bowl of bowls){
          const elapsed=(t-bowl.offset+period)%period,attack=Math.min(1,elapsed/.65);
          const tail=Math.min(1,Math.max(0,(period-elapsed)/2));
          const envelope=Math.sin(attack*Math.PI/2)**2*Math.exp(-elapsed/4.6)*tail*tail*(3-2*tail);
          for(const partial of bowl.partials)value+=Math.sin(partial.step*i+channel*.13)*partial.level*envelope;
        }
      }else{
        for(const [index,voice] of voices.entries()){
          const drift=.68+.32*Math.cos(phase*voice.cycles+voice.phase);
          const p=voice.step*i+channel*(index+1)*.09;
          const wave=Math.sin(p)+(kind==='still'?.08:.025)*Math.sin(2*p);
          value+=wave*voice.level*drift;
        }
        value*=.82+.18*Math.cos(phase*3);
      }
      samples[i]=value;
    }
    let mean=0;for(const value of samples)mean+=value;mean/=count;
    let energy=0,peak=0;for(let i=0;i<count;i++){samples[i]-=mean;energy+=samples[i]*samples[i];peak=Math.max(peak,Math.abs(samples[i]));}
    const scale=Math.min(.14/Math.sqrt(energy/count),.6/Math.max(peak,.0001));
    for(let i=0;i<count;i++)samples[i]*=scale;
    return samples;
  });
}

interface Tone {hz:number;to?:number;delay:number;length:number;level:number;triangle?:boolean}
const tones: Record<Cue,Tone[]> = {
  select:[{hz:620,to:490,delay:0,length:.055,level:.3}],
  start:[{hz:440,delay:0,length:.12,level:.34},{hz:660,delay:.065,length:.17,level:.25}],
  pause:[{hz:392,to:294,delay:0,length:.14,level:.34,triangle:true}],
  reset:[{hz:220,to:165,delay:0,length:.09,level:.32,triangle:true}],
  complete:[{hz:523.25,delay:0,length:.65,level:.2},{hz:783.99,delay:.18,length:.8,level:.12}],
  dismiss:[{hz:294,to:220,delay:0,length:.11,level:.24}],
};
export function cueSamples(kind: Cue, sampleRate=32000): Float32Array {
  const voices=tones[kind],length=Math.ceil((Math.max(...voices.map(v=>v.delay+v.length))+.025)*sampleRate);
  const samples=new Float32Array(length);
  for(const tone of voices){let phase=0;const count=Math.round(tone.length*sampleRate),start=Math.round(tone.delay*sampleRate),attack=Math.min(.008,tone.length*.15);
    for(let i=0;i<count;i++){
      const t=i/sampleRate,progress=t/tone.length;
      phase+=2*Math.PI*tone.hz*Math.pow((tone.to??tone.hz)/tone.hz,progress)/sampleRate;
      const wave=tone.triangle?(Math.sin(phase)-Math.sin(3*phase)/9+Math.sin(5*phase)/25)*.9:Math.sin(phase);
      const release=Math.max(0,(t-attack)/(tone.length-attack));
      const envelope=t<attack?t/attack:Math.pow(.0001,release);
      samples[start+i]+=wave*envelope*tone.level;
    }
  }
  return samples;
}
