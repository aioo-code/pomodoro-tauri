import {useEffect,useRef,useState,type CSSProperties,type PointerEvent} from 'react';
import {Check} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {accents,compactAccents,applyPreferenceColors,savePreferences,usePreferences} from '@/lib/preferences';
import {fromHsv,hsv,normalizeHex} from '@/lib/custom-color';
import {useTheme} from '@/lib/theme';
import {t} from '@/lib/i18n';
import './theme-palette.css';

export function ThemePalette(){
 const {values,saving,loaded}=usePreferences(),theme=useTheme(),disabled=saving||!loaded;
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(values.customAccent),[position,setPosition]=useState(()=>hsv(values.customAccent)),[text,setText]=useState(values.customAccent),[error,setError]=useState('');
 const latest=useRef(draft),pointer=useRef<number|undefined>(undefined),panel=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(pointer.current===undefined){setDraft(values.customAccent);latest.current=values.customAccent;setText(values.customAccent);setPosition(hsv(values.customAccent));}},[values.customAccent]);
 useEffect(()=>{if(open)applyPreferenceColors({accent:'custom',customAccent:draft});else applyPreferenceColors();},[open,draft,theme]);
 useEffect(()=>()=>applyPreferenceColors(),[]);
 useEffect(()=>{if(open)panel.current?.scrollIntoView({block:'nearest'});},[open]);
 const change=(next:typeof position)=>{const color=fromHsv(next.h,next.s,next.v);setPosition(next);latest.current=color;setDraft(color);setText(color);setError('');};
 const commit=async()=>{if(disabled)return;const color=latest.current;if(values.accent==='custom'&&color===values.customAccent)return;const ok=await savePreferences({accent:'custom',customAccent:color});if(!ok)setError(t('颜色未能保存，请重试。'));};
 const move=(event:PointerEvent<HTMLDivElement>)=>{const box=event.currentTarget.getBoundingClientRect();change({...position,s:Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),v:1-Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))});};
 const finish=(event:PointerEvent<HTMLDivElement>,cancel=false)=>{if(pointer.current!==event.pointerId)return;pointer.current=undefined;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);if(cancel){setDraft(values.customAccent);latest.current=values.customAccent;setText(values.customAccent);setPosition(hsv(values.customAccent));applyPreferenceColors();}else void commit();};
 const selectedCustom=values.accent==='custom'||!compactAccents.some(a=>a.id===values.accent),legacy=accents.find(a=>a.id===values.accent),swatch=values.accent==='custom'?values.customAccent:legacy?.[theme]??values.customAccent;
 return <div className="theme-palette">
  <div className="accent-options compact-palette" role="group" aria-label={t('主题色')}>
   {compactAccents.map(accent=><Button key={accent.id} variant="ghost" size="icon" className="accent-choice" data-color={accent.id} style={{'--swatch':accent.light,'--swatch-ink':'ink' in accent?accent.ink:'#fff'} as CSSProperties} aria-label={t(accent.label)} title={t(accent.label)} aria-pressed={values.accent===accent.id} disabled={disabled} onClick={()=>{setOpen(false);void savePreferences({accent:accent.id});}}>{values.accent===accent.id&&<Check/>}</Button>)}
   <Button id="custom-color-toggle" variant="ghost" size="icon" className="palette-toggle" aria-label={t('自定义主题色')} title={t('自定义主题色')} aria-expanded={open} aria-pressed={selectedCustom} disabled={disabled} style={{'--chosen-color':swatch} as CSSProperties} onClick={()=>{if(!open){const color=values.accent==='custom'?values.customAccent:swatch;latest.current=color;setDraft(color);setText(color);setPosition(hsv(color));}setOpen(value=>!value);}}></Button>
  </div>
  {open&&<div ref={panel} className="color-picker" role="group" aria-label={t('自定义主题色')} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);}}}>
   <div className="color-sv" role="slider" tabIndex={disabled?-1:0} aria-label={t('饱和度和明度')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position.s*100)} aria-valuetext={draft.toUpperCase()} style={{'--hue':position.h} as CSSProperties} onPointerDown={event=>{if(disabled||event.button>0)return;event.preventDefault();pointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);move(event);}} onPointerMove={event=>{if(pointer.current===event.pointerId)move(event);}} onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onKeyDown={event=>{const delta=event.shiftKey?.1:.01;if(event.key.startsWith('Arrow')){event.preventDefault();change({...position,s:Math.max(0,Math.min(1,position.s+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0))),v:Math.max(0,Math.min(1,position.v+(event.key==='ArrowUp'?delta:event.key==='ArrowDown'?-delta:0)))});}}} onKeyUp={event=>{if(event.key.startsWith('Arrow'))void commit();}}><i style={{left:`${position.s*100}%`,top:`${(1-position.v)*100}%`}}/></div>
   <label className="color-hue"><span className="sr-only">{t('色相')}</span><input id="custom-color-hue" type="range" min={0} max={359} value={Math.round(position.h)} disabled={disabled} aria-label={t('色相')} onChange={event=>change({...position,h:Number(event.target.value)})} onPointerUp={()=>void commit()} onKeyUp={()=>void commit()}/></label>
   <label className="color-hex"><span style={{background:draft}} aria-hidden="true"/><span className="sr-only">{t('十六进制颜色')}</span><input id="custom-color-hex" value={text} maxLength={7} spellCheck={false} autoComplete="off" disabled={disabled} aria-label={t('十六进制颜色')} onChange={event=>{setText(event.target.value);const color=normalizeHex(event.target.value);if(color){latest.current=color;setDraft(color);setPosition(hsv(color));setError('');}}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();const color=normalizeHex(text);if(color){latest.current=color;void commit();}else setError(t('请输入有效的十六进制颜色。'));}}} onBlur={()=>{const color=normalizeHex(text);if(color){latest.current=color;void commit();}}}/><span className="color-auto-note">{t('自动适配文字对比度')}</span></label>
   {error&&<p className="settings-error" role="alert">{error}</p>}
  </div>}
 </div>;
}
