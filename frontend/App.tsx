import {useCallback, useEffect, useRef, useState} from 'react';
import {ChevronLeft,ChevronRight,ArrowUpDown, Coffee, Expand, Focus, Pause, Play, Plus, RotateCcw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {Titlebar} from '@/components/titlebar';
import {TimerDisplay} from '@/components/timer-display';
import {TimerMessage} from '@/components/timer-message';
import {useTimerQuote} from '@/lib/quotes';
import {Settings} from '@/components/settings';
import {UsageHeatmap} from '@/components/usage-heatmap';
import CometDial from '@/components/reactbits/CometDial';
import {FocusButton} from '@/components/focus-button';
import {TimerView,timerViews} from '@/components/timer-views';
import SpotlightCard from '@/components/reactbits/SpotlightCard';
import {useTheme} from '@/lib/theme';
import JellyRadio from '@/components/reactbits/JellyRadio';
import RubberSegment from '@/components/reactbits/RubberSegment';
import {preferenceValues,savePreferences, usePreferences} from '@/lib/preferences';
import {t, useLanguage} from '@/lib/i18n';
import {drag} from '@/lib/drag';
import {useClock} from '@/hooks/use-clock';
import {useReducedMotion} from '@/hooks/use-reduced-motion';
import {formatTime, invoke} from '@/lib/api';
import {flushSync} from 'react-dom';
import {viewTransition} from '@/lib/view-transition';

export default function App() {
  const {clock, desktop, busy, windowBusy, error, act, windowAction, adjustRemaining} = useClock();
  const reduce = useReducedMotion();
  const theme=useTheme();
  const {values:preferences, saving} = usePreferences();
  const language = useLanguage();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [durationFocus, setDurationFocus] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState<number>();
  const frozenRange = useRef(3600);
  const closeSettings = useCallback(() => {void viewTransition(()=>{flushSync(()=>setSettingsOpen(false));requestAnimationFrame(()=>document.getElementById('settings')?.focus());},'settings-close',reduce);}, [reduce]);
  const mini = desktop?.mini ?? false;
  const up = preferences.direction === 'up';
  const showSettings = settingsOpen && !mini;
  const focus = clock?.mode !== 'break';
  const running = clock?.status === 'running';
  const completed = clock?.status === 'completed';
  const paused = clock?.status === 'paused';
  const statusText=t(!clock?'正在连接…':completed?'本段已完成':paused?'已暂停':running?focus?'专注中':'休息中':'准备开始');
  const selectedQuote=useTimerQuote(clock,preferences.quotes,preferences.quotesEnabled);
  const quote=clock?selectedQuote:'';
  const nativeRemaining = clock?.remainingMs ?? 1500000;
  const remainingMs = draft ?? nativeRemaining;
  const elapsedMs = Math.max(0,(clock?.durationMs ?? 1500000)-nativeRemaining);
  const time = formatTime(up ? Math.floor(elapsedMs/1000)*1000 : remainingMs);
  const label = t(running ? '暂停' : paused ? '继续' : completed ? '再来一段' : focus ? '开始专注' : '开始休息');
  const fraction = clock ? Math.min(1, Math.max(0,nativeRemaining/clock.durationMs)) : 1;
  const progress = up ? 1-fraction : fraction;
  const dialRange = dragging ? frozenRange.current : Math.min(86400,Math.max(3600,Math.ceil((clock?.durationMs ?? 1500000)/3600000)*3600));
  const start = () => act(running ? 'pause' : 'start');
  const changeView=(delta:number)=>{void viewTransition(async()=>{const index=timerViews.findIndex(v=>v.id===preferenceValues().timerStyle);await savePreferences({timerStyle:timerViews[(index+delta+timerViews.length)%timerViews.length].id});flushSync(()=>{});},'clock',reduce);};
  const editRemaining = (seconds:number) => {const ms=Math.round(seconds)*1000;setDraft(ms);adjustRemaining(ms,clock?.mode ?? 'focus');};
  useEffect(() => {if(mini)setSettingsOpen(false);document.body.classList.toggle('mini',mini);return () => document.body.classList.remove('mini');},[mini]);
  useEffect(() => {setDraft(undefined);setDragging(false);},[clock?.mode,up,mini]);
  useEffect(() => {if(!dragging && draft !== undefined && (error || clock && Math.abs(clock.remainingMs-draft)<1000))setDraft(undefined);},[clock,dragging,draft,error]);
  useEffect(() => {document.title=`${completed ? '✓ '+t('本段已完成') : time} · ${t('番茄时钟')}`;},[time,completed,language]);
  const activity = (inside:boolean) => {setHovered(inside);if(mini)void invoke('widget_activity',{inside});};
  const widgetContentOpacity=mini&&desktop?.widget.acrylic?(preferences.dimInactive&&desktop.widget.dimmed&&!hovered?Math.max(25,Math.round(preferences.miniOpacity*.6)):preferences.miniOpacity)/100:1;
  const tool = (id:string, name:string, icon:React.ReactNode, onClick:()=>void, disabled=false, pressed?:boolean) => <Tooltip><TooltipTrigger asChild><Button id={id} variant="ghost" size="icon" className={id==='direction'?'direction-action':'reset-action'} aria-label={name} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{icon}</Button></TooltipTrigger><TooltipContent>{name}</TooltipContent></Tooltip>;
  return <TooltipProvider delayDuration={450} compact={mini} suppressed={!!error}><SpotlightCard className={`app-shell ${mini?'is-mini':''} ${focus?'is-focus':'is-break'} ${up?'is-count-up':''}`} data-reduced-motion={reduce} data-clock-state={clock?.status} data-widget-acrylic={mini&&desktop?.widget.acrylic} theme={theme} disabled={mini||showSettings||reduce} spotlightColor="var(--clock-accent)" intensity={theme==='dark'?.065:.03} spotlightSize={260} softness={.88} borderGlow={.45} proximity={0} smoothing={.18} ambient={false} flare={false} grain={0} style={{'--widget-content-opacity':widgetContentOpacity,'--spotlight-card-surface':'transparent','--spotlight-card-border':'transparent','--spotlight-card-shadow':'none'} as React.CSSProperties} onPointerMove={event=>{event.currentTarget.dataset.overAction=String(event.target instanceof Element&&!!event.target.closest('#toggle'));}} onFocusCapture={event=>{event.currentTarget.dataset.overAction=String(event.target instanceof Element&&!!event.target.closest('#toggle'));}} data-widget-quiet={mini && desktop?.widget.dimmed && !hovered} onPointerEnter={()=>activity(true)} onPointerLeave={event=>{activity(false);event.currentTarget.dataset.overAction='false';}} onPointerDownCapture={event=>{if(windowBusy){event.preventDefault();event.stopPropagation();return;}if(event.pointerType==='touch')activity(true);}} onPointerUpCapture={event=>{if(event.pointerType==='touch')activity(false);}} onContextMenu={event=>{if(!mini)return;event.preventDefault();if((event.nativeEvent as PointerEvent).pointerType!=='touch')void invoke('widget_menu',{x:event.clientX,y:event.clientY});}}>
    {!mini && <Titlebar desktop={desktop} busy={windowBusy} onAction={windowAction} settingsOpen={showSettings} onSettings={()=>{setDurationFocus(false);void viewTransition(()=>flushSync(()=>setSettingsOpen(value=>!value)),showSettings?'settings-close':'settings-open',reduce);}}/>}
    <main aria-label={t('番茄时钟')} className={showSettings?'settings-main':undefined} onPointerDown={mini?drag:undefined} data-drag-handle={mini || undefined}>
      {showSettings && <Settings onClose={closeSettings} durationFocus={durationFocus}/>}
      <div hidden={showSettings} className="timer-stage">
        <section className="timer-settings" aria-label={t('选择时段')} hidden={mini}>
          <RubberSegment items={[{value:'focus',label:t('专注'),icon:<Focus/>},{value:'break',label:t('休息'),icon:<Coffee/>}]} value={clock?.mode ?? 'focus'} onChange={value=>void act(value)} disabled={!clock || busy} reducedMotion={reduce} className="mode-tabs" aria-label={t('选择时段')} trackColor="var(--control-track)" thumbColor="var(--surface-high)" textColor="var(--muted-foreground)" activeTextColor="var(--foreground)" radius={preferences.cornerRadius*.6} stretch={0} squash={0}/>
        </section>
        <div className="timer-panel" role="region" aria-labelledby={focus?'focus':'break'}>
          <div className="timer-carousel" role="group" aria-label={t("计时样式")}><>{!mini&&<Button id="timer-view-prev" className="timer-view-arrow" variant="ghost" size="icon" aria-label={t("上一种计时样式")} title={t("上一种计时样式")} disabled={saving||dragging||!clock} onClick={()=>changeView(-1)}><ChevronLeft/></Button>}</><section className="clock-section" data-timer-style={preferences.timerStyle} aria-label={t('倒计时')} onPointerDown={mini?drag:undefined} data-drag-handle={mini || undefined}>
            {!mini && <div className="timer-ring" data-remaining={fraction}><TimerView view={preferences.timerStyle} progress={progress} seconds={remainingMs/1000} editable={!!clock&&!up} reducedMotion={reduce} onStart={()=>{frozenRange.current=dialRange;setDragging(true);}} onChange={editRemaining} onEnd={value=>{editRemaining(value);setDragging(false);}}><CometDial value={Math.round((up?elapsedMs:remainingMs)/1000)} min={up?0:1} max={dialRange} step={1} unit="" size={238} sweep={300} thickness={1.8} accent="var(--clock-accent)" ink="var(--foreground)" label={t(up?'已用时间':'拖动调整剩余时间')} disabled={!clock || up} reducedMotion={reduce} momentum={0} tapBounce={0} flickBounce={0} cometReach={96} cometWidth={4} onChangeStart={()=>{frozenRange.current=dialRange;setDragging(true);}} onChange={editRemaining} onChangeEnd={value=>{editRemaining(value);setDragging(false);}}/></TimerView></div>}
            <div className="clock-face"><TimerDisplay time={time} mini={mini} remaining={progress} elapsed={up} animate={!dragging && !showSettings} hideDigits={!mini&&preferences.timerStyle==='arc'} layout={!mini&&preferences.timerStyle==='orbit'?'stacked':'horizontal'}/></div>
          </section>{!mini&&<Button id="timer-view-next" className="timer-view-arrow" variant="ghost" size="icon" aria-label={t("下一种计时样式")} title={t("下一种计时样式")} disabled={saving||dragging||!clock} onClick={()=>changeView(1)}><ChevronRight/></Button>}</div>
          {!mini && <div className="timer-caption"><TimerMessage quote={quote} status={statusText}/><p className="dial-hint" title={t(up?'正计时 · 已用时间':'拖动圆环调整时间，方向键按秒微调')}><span className="timer-style-name">{t(timerViews.find(v=>v.id===preferences.timerStyle)?.label??'彗星')}</span><span aria-hidden="true">·</span><span>{t(up?'正计时':'拖动调整')}</span></p></div>}
          <section className="duration-control" aria-label={t('选择时长')} hidden={mini}>
            <div className="duration-label"><span>{t('常用时长')}</span><span>{t('分钟')}</span></div>
            <div className="duration-options"><div className="presets"><JellyRadio items={preferences.durations.map(preset=>({value:String(preset.minutes),label:preset.minutes}))} value={clock?.adjusted?'':String(clock?.selectedMinutes ?? 25)} onChange={value=>void act(`minutes:${value}`)} disabled={!clock || busy} ariaLabel={t('快捷时长（分钟）')} size="sm" gap={4} radius={preferences.cornerRadius*.6} chipColor="transparent" activeColor="color-mix(in srgb,var(--primary) 14%,var(--surface-high))" textColor="var(--muted-foreground)" activeTextColor="var(--foreground)" swell={0} barge={0} shrink={0} reducedMotion={reduce}/>{!preferences.durations.length && <span className="empty-shortcuts">{t('添加一个常用时长')}</span>}</div><Tooltip><TooltipTrigger asChild><Button id="add-duration" variant="ghost" size="icon" aria-label={t('自定义时长')} onClick={()=>{void viewTransition(()=>flushSync(()=>{setDurationFocus(true);setSettingsOpen(true);}), 'settings-open',reduce);}}><Plus/></Button></TooltipTrigger><TooltipContent>{t('添加和管理时长')}</TooltipContent></Tooltip></div>
          </section>
          <div className="actions">
            {!mini && tool('direction',t(up?'切换为倒计时':'切换为正计时'),<ArrowUpDown/>,()=>void savePreferences({direction:up?'down':'up'}),saving,up)}
            {mini ? <Tooltip><TooltipTrigger asChild><Button id="toggle" className="primary-action" aria-label={label} disabled={!clock || busy} onClick={start}>{running?<Pause/>:<Play/>}<span className="toggle-label">{label}</span></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip> : <FocusButton label={label} icon={running?<Pause/>:<Play/>} running={running} disabled={!clock || busy} reducedMotion={reduce} onClick={start}/>}
            {!mini && tool('reset',t('重置当前时段'),<RotateCcw/>,()=>void act('reset'),!clock || busy)}
            {mini && <Tooltip><TooltipTrigger asChild><Button id="mini" variant="ghost" size="icon" className="restore-action" aria-label={t('返回主窗')} disabled={windowBusy} onClick={()=>windowAction('mini')}><Expand/></Button></TooltipTrigger><TooltipContent>{t('返回主窗')}</TooltipContent></Tooltip>}
          </div>
          {!mini && error && <p id="error" role="alert">{t(error)}<Button variant="link" size="sm" onClick={()=>window.location.reload()}>{t('重新连接')}</Button></p>}
        </div>
      </div>
    </main>
    {mini&&<><div className="mini-feedback" data-kind={error?'alert':quote?'quote':'status'} onPointerDown={error?undefined:drag} data-drag-handle={!error||undefined}>{error?<p id="error" role="alert">{t(error)}</p>:<TimerMessage quote={quote} status={statusText} mini/>}</div>{(error)&&<span id="status" className="sr-only" role="status">{statusText}</span>}</>}
    {!mini && !showSettings && <div className="activity-footer"><UsageHeatmap/></div>}
  </SpotlightCard></TooltipProvider>;
}
