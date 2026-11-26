import {useSyncExternalStore} from 'react';
import messages from '../locales/messages.json';
export type Language = 'zh' | 'en' | 'ja' | 'de' | 'eo';
export const languages: {id:Language; label:string}[] = [{id:'zh',label:'简体中文'},{id:'en',label:'English'},{id:'ja',label:'日本語'},{id:'de',label:'Deutsch'},{id:'eo',label:'Esperanto'}];
const indices = {zh:-1,en:0,ja:1,de:2,eo:3};
const catalog: Record<string,string[]> = messages;
let language: Language = 'zh';
const listeners = new Set<() => void>();
export function applyLanguage(next: Language) {
  const changed = next !== language;
  language = next;
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : next;
  document.documentElement.dataset.language = next;
  if (changed) listeners.forEach(listener => listener());
}
export function t(source:string, values:Record<string,string|number> = {}) {
  const text = catalog[source]?.[indices[language]] ?? source;
  return text.replace(/\{(\w+)\}/g, (match,key:string) => values[key] === undefined ? match : String(values[key]));
}
export function presetLabel(preset:{id:string;label:string;minutes:number}) {
  return preset.id === `default-${preset.minutes}` && preset.label === `${preset.minutes}分钟` ? t('{minutes}分钟',{minutes:preset.minutes}) : preset.label;
}
export function useLanguage() {return useSyncExternalStore(listener => {listeners.add(listener);return () => {listeners.delete(listener);};}, () => language);}
