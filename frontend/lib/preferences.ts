import { useSyncExternalStore } from 'react';
import { invoke } from '@/lib/api';
import type { IconChoice } from '@/lib/icon-choices';
import {applyLanguage, type Language} from '@/lib/i18n';
import {configureAudio, playCue, type AudioPreferences} from '@/lib/audio';
import {glassSurface} from '@/lib/glass-surface';
import {customColor} from '@/lib/custom-color';
import {defaultQuotes,type QuoteEntry} from '@/lib/quotes';

export const accents = [
  { id: 'tomato', label: '番茄红', light: '#f0534f', dark: '#f0534f', ink: '#2b0808', lightAccent: '#c53533', darkAccent: '#ff8274' },
  { id: 'blue', label: '湖蓝', light: '#216bb0', dark: '#85bce7' },
  { id: 'teal', label: '青碧', light: '#087b80', dark: '#74cbd0' },
  { id: 'green', label: '松绿', light: '#247748', dark: '#91c9a5' },
  { id: 'violet', label: '鸢紫', light: '#7650b4', dark: '#c0a5ee' },
  { id: 'rose', label: '蔷薇', light: '#b23f69', dark: '#eaa4bf' },
  { id: 'amber', label: '琥珀', light: '#916519', dark: '#e9c37e' },
  { id: 'candy-pink', label: '糖果粉', light: '#dc006a', dark: '#ff5ca8' },
  { id: 'candy-purple', label: '电光紫', light: '#8428ff', dark: '#bd7dff' },
  { id: 'candy-blue', label: '泡泡蓝', light: '#0085ff', dark: '#26a4ff', ink: '#071b2c' },
  { id: 'candy-orange', label: '蜜橙', light: '#ff7800', dark: '#ff941f', ink: '#30200f' },
  { id: 'candy-lime', label: '青柠', light: '#b5f300', dark: '#c4fa20', ink: '#23320d' },
  { id: 'black', label: '墨黑', light: '#20242a', dark: '#20242a', ink: '#f5f6f8', lightAccent: '#20242a', darkAccent: '#dce1e8' },
  { id: 'white', label: '月白', light: '#f5f6f8', dark: '#f5f6f8', ink: '#20242a', lightAccent: '#59616c', darkAccent: '#f5f6f8' },
] as const;
export type Accent = typeof accents[number]['id']|'custom';
export type TimerStyle='comet'|'arc'|'orbit'|'ticks'|'digits';
export const compactAccents=accents.filter(a=>['tomato','blue','candy-lime','black','white'].includes(a.id));
export type Position = 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-right';
export interface Preferences extends AudioPreferences {
  language: Language;
  direction: 'down' | 'up';
  numberAnimation: boolean;
  accent: Accent; position: Position; alwaysOnTop: boolean; reduceMotion: boolean;
  customAccent:string;timerStyle:TimerStyle;
  cornerRadius: number; durations: DurationPreset[];
  quotesEnabled:boolean;quotes:QuoteEntry[];
  acrylic: boolean;
  icon: IconChoice;
  miniOpacity: number; dimInactive: boolean; snapToEdges: boolean;
}
export interface DurationPreset { id: string; label: string; minutes: number }
interface Reply { values: Preferences; loadError?: string | null }
export const defaults: Preferences = { quotesEnabled:true,quotes:defaultQuotes,language: 'zh', direction: 'down', numberAnimation: true, accent: 'tomato', customAccent:'#9a64ff',timerStyle:'comet',customNoiseId:'',position: 'bottom-right', alwaysOnTop: true, reduceMotion: false, acrylic: true, icon: 'flow', cornerRadius: 20, durations: [5, 10, 15, 25, 30, 45, 60].map(minutes => ({ id: `default-${minutes}`, label: `${minutes}分钟`, minutes })), miniOpacity: 100, dimInactive: true, snapToEdges: true, audioMuted: false, interactionSounds: true, interactionVolume: 28, reminderNoise: true, noiseTexture: 'still', noiseVolume: 22 };
let state = { values: defaults, loaded: false, saving: false, error: '' };
let generation = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function notify() { listeners.forEach(listener => listener()); }

export function applyPreferenceColors(override:Partial<Preferences>={}) {
  const root = document.documentElement;
  const chosen={...state.values,...override},palette = accents.find(accent => accent.id === chosen.accent) ?? accents[0],custom=chosen.accent==='custom'?customColor(chosen.customAccent):undefined;
  const color = custom?.color??(root.dataset.theme === 'dark' ? palette.dark : palette.light);
  const ink = custom?(root.dataset.theme==='dark'?custom.darkInk:custom.lightInk):'lightAccent' in palette ? (root.dataset.theme === 'dark' ? palette.darkAccent : palette.lightAccent) : root.dataset.theme === 'light' && 'ink' in palette ? palette.ink : color;
  root.dataset.accent = chosen.accent;
  root.dataset.acrylic = String(state.values.acrylic);
  root.dataset.appReducedMotion = String(state.values.reduceMotion);
  root.style.setProperty('--primary', color);
  root.style.setProperty('--glass-surface',glassSurface(color,root.dataset.theme==='dark').css);
  root.style.setProperty('--primary-foreground', custom?.foreground??('ink' in palette ? palette.ink : root.dataset.theme === 'dark' ? '#132c41' : '#ffffff'));
  root.style.setProperty('--custom-button-effect',String(custom?.effect??1));
  root.style.setProperty('--clock-accent', custom||'lightAccent' in palette ? ink : color);
  root.style.setProperty('--ring', ink);
  root.style.setProperty('--accent-ink', ink);
  root.style.setProperty('--corner', `${state.values.cornerRadius}px`);
  root.style.setProperty('--window-corner', `${state.values.cornerRadius===0?0:state.values.cornerRadius<12?4:8}px`);
  root.style.setProperty('--corner-sm', `${state.values.cornerRadius * .6}px`);
  root.style.setProperty('--corner-xs', `${state.values.cornerRadius * .35}px`);
  root.dataset.cornerRadius = String(state.values.cornerRadius);
}
function accept(reply: Reply) {
  configureAudio(reply.values);
  state = { ...state, values: reply.values, loaded: true, error: reply.loadError ?? '' };
  applyLanguage(reply.values.language);
  applyPreferenceColors(); notify();
  window.dispatchEvent(new Event('pomodoro:preferences-synced'));
}
// Native events reach the hidden reminder without waiting for background timers.
void window.__TAURI__.event.listen<Reply>('preferences-changed', event => {
  generation++; accept(event.payload);
}).then(() => { document.documentElement.dataset.preferenceEvents = 'ready'; }).catch(error => console.error('Appearance sync:', error));
async function refresh() {
  const sample = generation;
  if (!state.saving) {
    try {
      const next = await invoke<Reply>('get_preferences');
      if (sample === generation && !state.saving && (!state.loaded || JSON.stringify(next.values) !== JSON.stringify(state.values))) accept(next);
    } catch { /* The timer can run while the settings service is starting. */ }
  }
  window.setTimeout(refresh, 750);
}
void refresh();

export async function savePreferences(patch: Partial<Preferences>) {
  if (state.saving) return false;
  generation++; state = { ...state, saving: true, error: '' }; notify();
  try { accept(await invoke<Reply>('set_preferences', { patch })); void playCue('select'); return true; }
  catch (error) { state = { ...state, error: String(error) }; return false; }
  finally { state = { ...state, saving: false }; notify(); }
}
export function usePreferences() { return useSyncExternalStore(subscribe, () => state); }
export async function saveReminderAudio(patch: Pick<Partial<Preferences>, 'noiseTexture' | 'noiseVolume'|'customNoiseId'>) {
  if (state.saving) return false;
  generation++; state = {...state, saving:true,error:''}; notify();
  try { accept(await invoke<Reply>('set_reminder_audio', {patch})); return true; }
  catch (error) { state={...state,error:String(error)}; return false; }
  finally { state={...state,saving:false}; notify(); }
}

export const preferenceValues=()=>state.values;
