import {useRef,useId,type ReactNode,type PointerEvent} from 'react';
import {type TimerStyle} from '@/lib/preferences';
import SloshGauge from '@/components/reactbits/SloshGauge';
import StatusMark from '@/components/reactbits/StatusMark';
import './timer-views.css';

export const timerViews=[{id:'comet',label:'彗星'},{id:'arc',label:'光环'},{id:'orbit',label:'水滴'},{id:'ticks',label:'刻度'},{id:'digits',label:'字面'}] as const;
interface Props {view:TimerStyle;progress:number;seconds:number;editable:boolean;reducedMotion?:boolean;children:ReactNode;onStart:()=>void;onChange:(value:number)=>void;onEnd:(value:number)=>void}
const clamp=(value:number)=>Math.min(86400,Math.max(1,Math.round(value)));
const dropPath='M50 8C46 8 44 13 40 19C30 34 19 45 17 60C15 75 28 96 50 96C72 96 85 75 83 60C81 45 70 34 60 19C56 13 54 8 50 8Z';
export function TimerView({view,progress,seconds,editable,reducedMotion=false,children,onStart,onChange,onEnd}:Props){
 const dropId='drop-'+useId().replaceAll(':','');
 const gesture=useRef<{id:number;x:number;y:number;angle:number;value:number;vertical:boolean}|undefined>(undefined),latest=useRef(seconds);
 const move=(event:PointerEvent<HTMLDivElement>)=>{const g=gesture.current;if(!g||g.id!==event.pointerId)return;const box=event.currentTarget.getBoundingClientRect(),angle=Math.atan2(event.clientY-box.top-box.height/2,event.clientX-box.left-box.width/2);let delta=angle-g.angle;if(delta>Math.PI)delta-=Math.PI*2;if(delta<-Math.PI)delta+=Math.PI*2;
  g.value=Math.min(86400,Math.max(1,g.value+(g.vertical?(g.y-event.clientY)*5:delta/(Math.PI*2)*3600)));g.y=event.clientY;g.angle=angle;latest.current=clamp(g.value);onChange(latest.current);
 };
 const finish=(event:PointerEvent<HTMLDivElement>)=>{if(gesture.current?.id!==event.pointerId)return;gesture.current=undefined;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);onEnd(latest.current);};
 const p=Math.min(1,Math.max(0,progress));
 return <div className="timer-view" data-view={view} data-progress={p} onPointerDownCapture={event=>{event.currentTarget.dataset.pointerUsed='true';if(view==='comet'||!editable||event.button>0)return;event.preventDefault();event.stopPropagation();const r=event.currentTarget.getBoundingClientRect(),x=event.clientX-r.left-r.width/2,y=event.clientY-r.top-r.height/2;gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,angle:Math.atan2(y,x),value:seconds,vertical:view==='digits'||Math.hypot(x,y)<24};latest.current=seconds;event.currentTarget.setPointerCapture(event.pointerId);event.currentTarget.querySelector<HTMLElement>('[role="slider"]')?.focus({preventScroll:true});onStart();}} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDownCapture={event=>{delete event.currentTarget.dataset.pointerUsed;if(view==='comet'||!editable)return;const step=event.shiftKey?10:1;const value=event.key==='Home'?1:event.key==='End'?86400:event.key==='PageUp'?seconds+60:event.key==='PageDown'?seconds-60:['ArrowRight','ArrowUp'].includes(event.key)?seconds+step:['ArrowLeft','ArrowDown'].includes(event.key)?seconds-step:undefined;if(value===undefined)return;event.preventDefault();event.stopPropagation();const next=clamp(value);onStart();onChange(next);onEnd(next);}}>
  <div className="timer-view-input">{children}</div>
  {view==='arc'&&<div className="timer-view-effect quiet-halo" aria-hidden="true"><StatusMark status="running" progress={p} size={216} strokeWidth={.95} color="var(--clock-accent)" fillOpacity={0} strike={false} reducedMotion={reducedMotion}/></div>}
  {view==='orbit'&&<div className="timer-view-effect liquid-clock droplet-clock" aria-hidden="true"><svg className="drop-outline" viewBox="0 0 100 100"><defs><clipPath id={dropId} clipPathUnits="objectBoundingBox"><path d={dropPath} transform="scale(.01)"/></clipPath></defs><path d={dropPath}/></svg><div className="drop-liquid" style={{clipPath:`url(#${dropId})`}}><SloshGauge value={p*100} showValue={false} interactive={false} liquidColor="var(--clock-accent)" glassColor="transparent" width={180} height={180} radius={0} ticks={0} tilt={reducedMotion?0:.12} splash={.05} viscosity={reducedMotion?0:.12} reducedMotion={reducedMotion}/></div></div>}
  {(view==='ticks'||view==='digits')&&<svg viewBox="0 0 240 240" className="timer-view-art" aria-hidden="true">
   {view==='ticks'&&<><circle cx="120" cy="120" r="86" className="view-track precision-track"/><circle cx="120" cy="120" r="86" className="view-progress precision-progress" transform="rotate(-90 120 120)" strokeDasharray={`${2*Math.PI*86*p} ${2*Math.PI*86}`} opacity={p>0?1:0}/>{Array.from({length:60},(_,index)=>{const a=(index/60*360-90)*Math.PI/180,major=index%5===0;return <line key={index} x1={120+Math.cos(a)*(major?96:100)} y1={120+Math.sin(a)*(major?96:100)} x2={120+Math.cos(a)*104} y2={120+Math.sin(a)*104} strokeWidth={major?1.8:1} strokeLinecap="round" className={index<Math.ceil(p*60)?'view-progress':'view-track'}/>;})}</>}
   {view==='digits'&&<g strokeWidth="2" strokeLinecap="round"><line x1="52" y1="170" x2="188" y2="170" className="view-track"/><line x1="52" y1="170" x2={52+136*p} y2="170" className="view-progress" opacity={p>0?1:0}/></g>}
  </svg>}
 </div>;
}
