import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, type Desktop, type Snapshot } from '@/lib/api';
import {playCue} from '@/lib/audio';
import {flushSync} from 'react-dom';
import {animateWindowEntry,cancelSceneTransition} from '@/lib/view-transition';
export function useClock() {
  const [clock, setClock] = useState<Snapshot>();
  const [desktop, setDesktop] = useState<Desktop>();
  const [busy, setBusy] = useState(false);
  const [windowBusy, setWindowBusy] = useState(false);
  const [error, setError] = useState('');
  const last = useRef({ revision: -1, sample: -1 });
  const mutation = useRef(false);
  const windowMutation = useRef(false);
  const mounted = useRef(true);
  const adjustment = useRef<{milliseconds:number;mode:string} | undefined>(undefined);
  const adjusting = useRef(false);
  const lastAdjustment = useRef(0);
  const accept = useCallback((next: Snapshot, sample: number) => {
    if (!mounted.current || next.revision < last.current.revision || (next.revision === last.current.revision && sample < last.current.sample)) return;
    last.current = { revision: next.revision, sample }; setClock(next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>, desktopTimer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!mounted.current) return;
      if (!mutation.current) {
        const sample = performance.now();
        try { accept(await invoke<Snapshot>('snapshot'), sample); if (mounted.current) setError(current => current === '计时服务暂时不可用，正在重试。' ? '' : current); }
        catch { if (mounted.current) setError('计时服务暂时不可用，正在重试。'); }
      }
      if (mounted.current) timer = setTimeout(poll, 200);
    };
    const pollDesktop = async () => {
      if (!mounted.current) return;
      try { if (!windowMutation.current) { const next = await invoke<Desktop>('desktop_state'); if (mounted.current && !windowMutation.current) { setDesktop(next); setError(current => current === '窗口状态暂时不可用，请重试。' ? '' : current); } } }
      catch { if (mounted.current) setError('窗口状态暂时不可用，请重试。'); }
      if (mounted.current) desktopTimer = setTimeout(pollDesktop, 500);
    };
    poll(); pollDesktop();
    return () => { mounted.current = false; clearTimeout(timer); clearTimeout(desktopTimer); };
  }, [accept]);
  const act = useCallback(async (action: string) => {
    if (mutation.current) return;
    if (['focus','break','reset'].includes(action) || action.startsWith('minutes:')) adjustment.current = undefined;
    mutation.current = true; setBusy(true); const sample = performance.now();
    try { const next=await invoke<Snapshot>('action', { action }); accept(next, sample); setError(''); void playCue(action==='reset'?'reset':['start','resume','toggle'].includes(action)?(next.status==='running'?'start':'pause'):action==='pause'?'pause':'select'); }
    catch (error) { setError(String(error)); }
    finally { mutation.current = false; if (mounted.current) setBusy(false); }
  }, [accept]);
  const windowAction = useCallback(async (action: string) => {
    if (windowMutation.current) return;
    windowMutation.current = true; setWindowBusy(true);
    try {
      if(action==='mini')cancelSceneTransition();
      const result=await invoke<Desktop|null>('desktop_action',{action});
      const next=result??await invoke<Desktop>('desktop_state');
      flushSync(()=>setDesktop(next));setError('');
      if(action==='mini')animateWindowEntry();
      void playCue('select');
    }
    catch (error) { setError(String(error)); }
    finally { windowMutation.current = false; if (mounted.current) setWindowBusy(false); }
  }, []);
  const adjustRemaining = useCallback((milliseconds:number, mode:string) => {
    adjustment.current = {milliseconds:Math.max(1000, Math.min(86400000, Math.round(milliseconds))),mode};
    if (adjusting.current) return;
    adjusting.current = true;
    void (async () => {
      try {
        while (adjustment.current && mounted.current) {
          const wait = Math.max(0,75-(performance.now()-lastAdjustment.current));
          if (wait) await new Promise(resolve => setTimeout(resolve,wait));
          if (!mounted.current || !adjustment.current) break;
          const next = adjustment.current; adjustment.current = undefined;
          lastAdjustment.current = performance.now();
          const sample = performance.now();
          accept(await invoke<Snapshot>('action', {action:`remaining:${next.mode}:${next.milliseconds}`}), sample);
          setError('');
        }
      } catch(error) { adjustment.current = undefined; setError(String(error)); }
      finally {adjusting.current = false;}
    })();
  }, [accept]);
  return { clock, desktop, busy, windowBusy, error, act, windowAction, adjustRemaining };
}
