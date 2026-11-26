// Adapted from React Bits Elastic Slider's rubber stretch and active thickness.
// Copyright (c) 2026 David Haz. See ElasticSlider.LICENSE.md and micro-sources.json.
// A native range retains immediate value tracking, keyboard access and touch scrolling.
import {useEffect,useRef,useState,type PointerEvent} from 'react';
import {animate,motion,useMotionValue} from 'motion/react';
import './ElasticSlider.css';

interface Props {
  id:string;label:string;value:number;min?:number;max?:number;step?:number;
  disabled?:boolean;reducedMotion?:boolean;maxStretch?:number;trackHeight?:number;
  formatValue?:(value:number)=>string;
  onChange:(value:number)=>void;onChangeEnd:()=>void;
}
const keys=['Home','End','PageUp','PageDown','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'];
export default function ElasticSlider({id,label,value,min=0,max=100,step=1,disabled=false,reducedMotion=false,maxStretch=10,trackHeight=6,formatValue=value=>`${value}%`,onChange,onChangeEnd}:Props) {
  const [active,setActive]=useState(false),[hovered,setHovered]=useState(false);
  const pointer=useRef<number|undefined>(undefined),initial=useRef(value),input=useRef<HTMLInputElement>(null);
  const stop=useRef<(()=>void)|undefined>(undefined),scaleX=useMotionValue(1),scaleY=useMotionValue(1),origin=useMotionValue('50% 50%');
  const callbacks=useRef({onChange,onChangeEnd});callbacks.current={onChange,onChangeEnd};
  const reset=()=>{stop.current?.();if(reducedMotion){scaleX.set(1);scaleY.set(1);return;}
    const x=animate(scaleX,1,{type:'spring',stiffness:360,damping:25}),y=animate(scaleY,1,{type:'spring',stiffness:360,damping:25});stop.current=()=>{x.stop();y.stop();};
  };
  useEffect(()=>()=>stop.current?.(),[]);
  useEffect(()=>{if(reducedMotion){stop.current?.();scaleX.set(1);scaleY.set(1);}},[reducedMotion,scaleX,scaleY]);
  useEffect(()=>{if(disabled){setHovered(false);if(pointer.current!==undefined){callbacks.current.onChange(initial.current);pointer.current=undefined;setActive(false);stop.current?.();scaleX.set(1);scaleY.set(1);}}},[disabled,scaleX,scaleY]);
  const stretch=(event:PointerEvent<HTMLInputElement>)=>{
    if(pointer.current!==event.pointerId||reducedMotion)return;
    const rect=event.currentTarget.getBoundingClientRect(),distance=event.clientX<rect.left?event.clientX-rect.left:event.clientX>rect.right?event.clientX-rect.right:0;
    const amount=maxStretch>0?2*(1/(1+Math.exp(-Math.abs(distance)/60))-.5)*maxStretch:0;
    stop.current?.();origin.set(distance<0?'100% 50%':'0% 50%');scaleX.set(1+amount/Math.max(1,rect.width));scaleY.set(1-amount/Math.max(1,maxStretch)*.12);
  };
  const finish=(event:PointerEvent<HTMLInputElement>,cancelled=false)=>{
    if(pointer.current!==event.pointerId)return;
    pointer.current=undefined;setActive(false);reset();
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(cancelled)callbacks.current.onChange(initial.current);else callbacks.current.onChangeEnd();
  };
  return <div className="elastic-slider" data-active={active} data-disabled={disabled} data-reduced-motion={reducedMotion}>
    <input ref={input} id={id} className="elastic-slider__input" type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} aria-valuetext={formatValue(value)}
      onChange={event=>onChange(Number(event.target.value))}
      onPointerEnter={event=>{if(!disabled&&event.pointerType==='mouse')setHovered(true);}} onPointerLeave={()=>setHovered(false)}
      onPointerDown={event=>{if(disabled||!event.isPrimary||event.button!==0)return;stop.current?.();pointer.current=event.pointerId;initial.current=value;setActive(true);event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={stretch} onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onLostPointerCapture={event=>finish(event)}
      onKeyDown={event=>{if(keys.includes(event.key))setActive(true);}} onKeyUp={event=>{if(keys.includes(event.key)){setActive(false);reset();onChangeEnd();}}}
      onBlur={()=>{if(pointer.current===undefined){setActive(false);reset();onChangeEnd();}}}/>
    <div className="elastic-slider__slot" aria-hidden="true"><motion.div className="elastic-slider__track" style={{scaleX,scaleY,transformOrigin:origin}} animate={{height:reducedMotion?trackHeight:active?trackHeight*2:hovered?trackHeight*4/3:trackHeight}} transition={reducedMotion?{duration:0}:{type:'spring',stiffness:360,damping:28}}><div className="elastic-slider__range" style={{width:`${Math.min(100,Math.max(0,(value-min)/Math.max(1,max-min)*100))}%`}}/></motion.div></div>
  </div>;
}
