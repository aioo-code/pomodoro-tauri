import {useEffect, useState} from 'react';
import {invoke} from '@/lib/api';
import {t, useLanguage} from '@/lib/i18n';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';

interface Usage { days: {date: string; count: number}[]; error?: string }
export function UsageHeatmap() {
  const [usage, setUsage] = useState<Usage>();
  const [active, setActive] = useState(29);
  const language = useLanguage();
  useEffect(() => {
    let live = true, stop: (() => void) | undefined;
    const update = () => { void invoke<Usage>('usage_snapshot').then(next => {if(live)setUsage(next);}).catch(() => {if(live)setUsage({days:[],error:'使用记录暂时不可用'});}); };
    update();
    void window.__TAURI__.event.listen('usage-changed', update).then(unlisten => {if(live)stop=unlisten;else unlisten();}).catch(() => {});
    const timer = setInterval(update, 60000);
    return () => {live=false;stop?.();clearInterval(timer);};
  }, []);
  const total = usage?.days.reduce((sum,day) => sum+day.count,0) ?? 0;
  return <footer className="usage-footer" aria-label={t('近30天完成 {count} 次专注',{count:total})}>
    <span className="usage-caption">{t('近30天')}</span>
    <div className="usage-heatmap" role="group" aria-label={t('使用频率')} data-total={total}>
      {usage?.days.map((day,index) => {
        const level=day.count===0?0:day.count===1?1:day.count<4?2:day.count<7?3:4;
        const date=new Intl.DateTimeFormat(language==='zh'?'zh-CN':language,{month:'short',day:'numeric'}).format(new Date(day.date+'T12:00:00'));
        const label=t('{date} · 完成 {count} 次专注',{date,count:day.count});
        return <Tooltip key={day.date}><TooltipTrigger asChild><span className="usage-day" role="img" aria-label={label} tabIndex={active===index?0:-1} data-date={day.date} data-count={day.count} data-level={level} onFocus={()=>setActive(index)} onKeyDown={event=>{
          const next=event.key==='ArrowRight'?Math.min(29,index+1):event.key==='ArrowLeft'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?29:-1;
          if(next<0)return;event.preventDefault();setActive(next);(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('.usage-day')[next])?.focus();
        }}/></TooltipTrigger><TooltipContent side="top">{label}</TooltipContent></Tooltip>;
      })}
      {usage?.error && <span className="usage-unavailable" role="status">{t(usage.error)}</span>}
    </div>
  </footer>;
}
