import { t } from '@/lib/i18n';
import {playCue} from '@/lib/audio';
import { useState } from 'react';
import { drag } from '@/lib/drag';
import CountUp from '@/components/reactbits/CountUp';
import WakeSlider from '@/components/reactbits/WakeSlider';
import {Tooltip,TooltipTrigger,TooltipContent} from '@/components/ui/tooltip';
import {usePreferences} from '@/lib/preferences';
import {useReducedMotion} from '@/hooks/use-reduced-motion';

export function TimerDisplay({ time, mini, remaining, elapsed = false, animate = true,hideDigits=false,layout="horizontal" }: { time: string; mini: boolean; remaining: number; elapsed?:boolean; animate?:boolean;hideDigits?:boolean;layout?:"horizontal"|"stacked" }) {
  const [quiet, setQuiet] = useState(() => localStorage.getItem('pomodoro.mini-view.v1') === 'progress');
  const [minutes, seconds] = time.split(':');
  const {values} = usePreferences();
  const reduce = useReducedMotion();
  const animated = values.numberAnimation && !reduce && animate && !hideDigits && !(mini && quiet);
  const digit = (value:string) => animated ? <CountUp className="rolling-number" from={Number(value)} to={Number(value)} minIntegerDigits={2} rollDirection={elapsed?'up':'down'} duration={.24} trigger="load" mode="roll" decimals={0} easing="easeOut"/> : value;
  const toggle = () => {void playCue('select');setQuiet(previous => { const next = !previous; localStorage.setItem('pomodoro.mini-view.v1', next ? 'progress' : 'digits'); return next; });};
  const digits = <span id="time" data-time={time} data-numbers-animated={animated} data-layout={layout} role="timer" aria-live="off" aria-label={t(elapsed ? '已用 {minutes} 分 {seconds} 秒' : '剩余 {minutes} 分 {seconds} 秒',{minutes,seconds})} data-length={time.length > 6 ? 'long' : time.length > 5 ? 'medium' : 'normal'} className={`time-digits ${mini ? '' : hideDigits?'sr-only':'time-composition'}`}>{mini ? <>{digit(minutes)}:{digit(seconds)}</> : <><span className="time-minutes" aria-hidden="true">{digit(minutes)}</span><span className="time-seconds" aria-hidden="true">{digit(seconds)}</span></>}</span>;
  if (!mini) return digits;
  return <Tooltip><TooltipTrigger asChild><button type="button" className="mini-time-control" data-view={quiet ? 'progress' : 'digits'} aria-label={t(elapsed ? '已用 {minutes} 分 {seconds} 秒' : '剩余 {minutes} 分 {seconds} 秒',{minutes,seconds}) + ', ' + t(quiet ? '切换为数字' : '切换为简洁进度')} onPointerDown={event => drag(event, toggle)} onClick={event => { if (event.detail === 0) toggle(); }}>
    <span className="mini-view-digits" aria-hidden={quiet}>{digits}</span>
    <span className="mini-view-progress" aria-hidden={!quiet}><span className="mini-progress" data-remaining={remaining}><WakeSlider value={remaining*100} min={0} max={100} step={.001} bars={28} height={18} restHeight={4} gap={2} fillColor="var(--clock-accent)" trackColor="color-mix(in srgb,var(--foreground) 12%,transparent)" crestColor="var(--primary)" reach={3} skew={.2} glide={.24} smoothing={120} sensitivity={.5} readOnly reducedMotion={reduce||!quiet}/></span></span>
  </button></TooltipTrigger><TooltipContent>{t(quiet ? '切换为数字' : '切换为简洁进度')}</TooltipContent></Tooltip>;
}
