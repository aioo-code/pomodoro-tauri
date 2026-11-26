import {useLayoutEffect,type RefObject} from 'react';
import './scroll-feather.css';

export const settingsScrollEdges={top:32,bottom:36};

// Fade the complete scroll composition, including the blurred copy. Blurring
// alone leaves an opaque cut at the scrollport's physical clipping boundary.
export function useScrollFeather(ref:RefObject<HTMLDivElement|null>) {
  useLayoutEffect(()=>{
    const scroll=ref.current,viewport=scroll?.parentElement;
    if(!scroll||!viewport)return;
    let frame=0;
    const write=(name:string,value:string)=>{if(viewport.style.getPropertyValue(name)!==value)viewport.style.setProperty(name,value);};
    const update=()=>{
      if(frame)cancelAnimationFrame(frame);
      frame=0;
      const limit=Math.max(0,scroll.scrollHeight-scroll.clientHeight),offset=Math.max(0,Math.min(limit,scroll.scrollTop));
      const cap=scroll.clientHeight*.22;
      write('--settings-fade-top',`${Math.min(settingsScrollEdges.top,offset,cap).toFixed(3)}px`);
      write('--settings-fade-bottom',`${Math.min(settingsScrollEdges.bottom,limit-offset,cap).toFixed(3)}px`);
      write('--settings-scrollbar-width',`${Math.max(0,scroll.offsetWidth-scroll.clientWidth)}px`);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    update();
    scroll.addEventListener('scroll',schedule,{passive:true});
    const observer=new ResizeObserver(update);observer.observe(scroll);
    if(scroll.firstElementChild)observer.observe(scroll.firstElementChild);
    return()=>{
      cancelAnimationFrame(frame);observer.disconnect();scroll.removeEventListener('scroll',schedule);
      for(const name of['--settings-fade-top','--settings-fade-bottom','--settings-scrollbar-width'])viewport.style.removeProperty(name);
    };
  },[ref]);
}
