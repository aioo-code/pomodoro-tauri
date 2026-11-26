// Adapted from React Bits ChromaGrid: damped pointer reveal, soft mask and idle RAF.
// Source and license: ScrollChroma.LICENSE.md.
import {useEffect,type RefObject} from 'react';

export function useChromaSpotlight(ref:RefObject<HTMLButtonElement|null>,disabled:boolean,reducedMotion:boolean) {
  useEffect(()=>{
    const root=ref.current;
    if(!root)return;
    root.dataset.spotlight='false';
    root.style.setProperty('--chroma-power','0');
    if(disabled||reducedMotion)return;
    const state={x:0,y:0,tx:0,ty:0,power:0,target:0,primed:false};
    let raf=0,last=0;
    const frame=(now:number)=>{
      raf=0;
      const dt=last?Math.min(.05,(now-last)/1000):1/60;
      last=now;
      const follow=1-Math.exp(-dt/.045);
      state.x+=(state.tx-state.x)*follow;
      state.y+=(state.ty-state.y)*follow;
      state.power+=(state.target-state.power)*(1-Math.exp(-dt/(state.target>state.power?.055:.075)));
      root.style.setProperty('--chroma-x',`${state.x.toFixed(2)}px`);
      root.style.setProperty('--chroma-y',`${state.y.toFixed(2)}px`);
      root.style.setProperty('--chroma-power',state.power.toFixed(4));
      const settled=Math.abs(state.tx-state.x)<.1&&Math.abs(state.ty-state.y)<.1&&Math.abs(state.target-state.power)<.002;
      if(settled){root.style.setProperty('--chroma-power',String(state.target));last=0;}
      else raf=requestAnimationFrame(frame);
    };
    const wake=()=>{if(!raf)raf=requestAnimationFrame(frame);};
    const move=(event:PointerEvent)=>{
      if(event.pointerType!=='mouse')return;
      const box=root.getBoundingClientRect();
      state.tx=event.clientX-box.left;state.ty=event.clientY-box.top;
      if(!state.primed||state.power<.02){state.x=state.tx;state.y=state.ty;state.primed=true;}
      state.target=1;root.dataset.spotlight='true';wake();
    };
    const leave=()=>{state.target=0;root.dataset.spotlight='false';wake();};
    root.addEventListener('pointerenter',move);root.addEventListener('pointermove',move);
    root.addEventListener('pointerleave',leave);root.addEventListener('pointercancel',leave);
    return()=>{
      cancelAnimationFrame(raf);
      root.removeEventListener('pointerenter',move);root.removeEventListener('pointermove',move);
      root.removeEventListener('pointerleave',leave);root.removeEventListener('pointercancel',leave);
      root.dataset.spotlight='false';root.style.setProperty('--chroma-power','0');
    };
  },[ref,disabled,reducedMotion]);
}
