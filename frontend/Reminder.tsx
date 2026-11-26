import {t,useLanguage} from '@/lib/i18n';
import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {X} from 'lucide-react';
import {motion} from 'motion/react';
import {useReducedMotion} from '@/hooks/use-reduced-motion';
import {Button} from '@/components/ui/button';
import {invoke,type Reminder as ReminderState} from '@/lib/api';
import {AppMark} from '@/components/app-mark';
import {ReminderAudio} from '@/components/reminder-audio';
import Orb from '@/components/reactbits/Orb';
import {accents,usePreferences} from '@/lib/preferences';
import {playCue,playNoise,stopNoise} from '@/lib/audio';
import {useTheme} from '@/lib/theme';

const comforts=['慢慢呼吸，轻轻放松。','喝口水，休息片刻。','按自己的节奏继续。'];
export default function Reminder() {
  const language=useLanguage(),reduce=useReducedMotion(),theme=useTheme();
  const {values,loaded}=usePreferences();
  const [state,setState]=useState<ReminderState>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [comfort,setComfort]=useState(-1),[orbActive,setOrbActive]=useState(false);
  const messageRef=useRef<HTMLDivElement>(null),[scrollable,setScrollable]=useState(false);
  useEffect(()=>{
    const element=messageRef.current;if(!element)return;
    const sync=()=>setScrollable(element.scrollHeight>element.clientHeight+1);
    const resize=new ResizeObserver(sync),mutation=new MutationObserver(sync);
    resize.observe(element);mutation.observe(element,{subtree:true,childList:true,characterData:true});sync();
    return()=>{resize.disconnect();mutation.disconnect();};
  },[]);
  const closing=useRef(false),pulseTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const palette=accents.find(accent=>accent.id===values.accent)??accents[0];
  const orbColors=values.accent==='custom'?[values.customAccent,values.customAccent,values.customAccent]:'lightAccent' in palette ? [palette.lightAccent,palette.darkAccent,theme==='dark'?palette.darkAccent:palette.lightAccent] : [palette.light,palette.dark,palette[theme]];
  useEffect(()=>{document.title=t('到时提醒');},[language]);
  useEffect(()=>{setComfort(-1);setOrbActive(false);},[state?.revision]);
  useEffect(()=>()=>clearTimeout(pulseTimer.current),[]);
  useEffect(()=>{
    let cancelled=false,generation=0,timer:ReturnType<typeof setTimeout>,unlisten:(()=>void)|undefined;
    const accept=(next:ReminderState)=>setState(previous=>previous&&previous.revision>next.revision?previous:next);
    void window.__TAURI__.event.listen<ReminderState>('reminder-changed',event=>{generation++;if(!cancelled)accept(event.payload);}).then(stop=>{if(cancelled)stop();else unlisten=stop;}).catch(()=>{});
    const poll=async()=>{const sample=generation;
      try{const next=await invoke<ReminderState>('reminder_state');if(!cancelled&&sample===generation)accept(next);}
      catch{if(!cancelled)setError('提醒状态暂时不可用，请重试关闭。');}
      if(!cancelled)timer=setTimeout(poll,350);
    };
    void poll();return()=>{cancelled=true;clearTimeout(timer);unlisten?.();};
  },[]);
  useEffect(()=>{
    if(loaded&&state?.pending&&values.reminderNoise)void playNoise();
    else void stopNoise(.18);
    return()=>{void stopNoise(.18);};
  },[loaded,state?.pending,state?.revision,values.reminderNoise]);
  const connect=()=>{setComfort(value=>(value+1)%comforts.length);setOrbActive(true);void playCue('complete');clearTimeout(pulseTimer.current);pulseTimer.current=setTimeout(()=>setOrbActive(false),650);};
  const dismiss=async()=>{if(closing.current)return;closing.current=true;setBusy(true);void playCue('dismiss');
    try{await stopNoise(.18);await invoke('dismiss_reminder');setError('');}
    catch{setError('未能关闭提醒，请再试一次。');}
    finally{closing.current=false;setBusy(false);}
  };
  useEffect(()=>{const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();void dismiss();}};document.addEventListener('keydown',keydown);return()=>document.removeEventListener('keydown',keydown);});
  const focus=state?.mode!=='break';
  return <div className="reminder-shell reminder-calm">
    <motion.button type="button" id="orb-interaction" aria-label={t('轻触光环，给自己一点鼓励')} data-feedback={comfort} onClick={connect} onFocus={()=>setOrbActive(true)} onBlur={()=>setOrbActive(false)} key={state?.revision} initial={reduce?false:{opacity:0}} animate={{opacity:1}} transition={{duration:1.2}} className="reminder-orb-background orb-completion" style={{'--orb-color':orbColors[2]} as CSSProperties}>
      {state?.pending&&!reduce&&<Orb colors={orbColors} backgroundColor="transparent" size={.92} glow={.26} wobble={.32} speed={.18} opacity={.8} intro={false} followCursor rotateOnHover hoverIntensity={.25} forceHoverState={orbActive} clickPulse dpr={1.25} className="reminder-orb"/>}
    </motion.button>
    <header className="titlebar"><div className="brand"><AppMark/>{t('到时提醒')}</div><div className="reminder-header-actions"><ReminderAudio compact/><Button id="close-reminder" variant="ghost" size="icon" aria-label={t('关闭提醒')} onClick={()=>void dismiss()} disabled={busy} className="window-button"><X/></Button></div></header>
    <section className="reminder-content" role="alertdialog" aria-modal="false" aria-labelledby="reminder-title" aria-describedby="reminder-message">
      <div ref={messageRef} className="reminder-message-region" data-scrollable={scrollable||undefined}><span className="reminder-eyebrow">{t(focus?'此刻，留给自己':'新的节奏，从容开始')}</span><h1 id="reminder-title">{t(focus?'专注完成':'休息结束')}</h1><p id="reminder-message" aria-live="polite">{t(comfort>=0?comforts[comfort]:focus?'辛苦了，给自己一个小小的休息。':'准备好后，再开始下一段专注。')}</p></div>
      <div className="reminder-actions"><ReminderAudio/><Button id="dismiss" aria-label={t('知道了，关闭提醒')} onClick={()=>void dismiss()} disabled={busy}>{t('知道了')}</Button>{error&&<p id="reminder-error" role="alert">{t(error)}</p>}</div>
    </section>
  </div>;
}
