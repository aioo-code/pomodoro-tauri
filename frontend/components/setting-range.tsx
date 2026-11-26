import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ElasticSlider from '@/components/reactbits/ElasticSlider';
import {useReducedMotion} from '@/hooks/use-reduced-motion';

export function SettingRange({ id, label, value, min, max, disabled, format = String, left, right, save, preview, onPreview, elastic=false }: {
  id: string; label: string; value: number; min: number; max: number; disabled: boolean;
  format?: (value: number) => string; left: string; right: string;
  save: (value: number) => Promise<boolean>; preview?: (value: number) => ReactNode; onPreview?: (value: number) => void;
  elastic?:boolean;
}) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(value), pending = useRef(false);
  const reducedMotion=useReducedMotion();
  useEffect(() => { latest.current = value; setDraft(value); }, [value]);
  const commit = () => {
    if (pending.current || disabled || latest.current === value) return;
    pending.current = true;
    void save(latest.current).then(saved => { if (!saved) { latest.current = value; setDraft(value); onPreview?.(value); } }).finally(() => { pending.current = false; });
  };
  const change=(next:number)=>{latest.current=next;setDraft(next);onPreview?.(next);};
  return <div className="setting-block range-setting"><label htmlFor={id} className="setting-row-label"><span className="setting-label">{label}</span><output htmlFor={id}>{format(draft)}</output></label>{elastic?<ElasticSlider id={id} label={label} value={draft} min={min} max={max} disabled={disabled} reducedMotion={reducedMotion} formatValue={format} onChange={change} onChangeEnd={commit}/>:<input id={id} type="range" min={min} max={max} step="1" value={draft} aria-valuetext={format(draft)} disabled={disabled} style={{ '--range-progress': `${(draft - min) / (max - min) * 100}%` } as CSSProperties} onChange={event => change(Number(event.target.value))} onPointerUp={commit} onKeyUp={event => { if (['Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) commit(); }} onBlur={commit}/>}<div className="range-labels"><span>{left}</span><span>{right}</span></div>{preview?.(draft)}</div>;
}
