import {useEffect,useRef,useState} from 'react';
import type {Snapshot} from '@/lib/api';
import {t} from '@/lib/i18n';

export interface QuoteEntry {id:string;text:string}
// Original, unattributed prompts. Only untouched built-ins follow UI language.
export const defaultQuotes:QuoteEntry[]=['先做好眼前这一小步。','把注意力，交给此刻。','慢一点，也在向前。','让行动先于犹豫。','专注当下，日有所进。','把今天的坚持，留给明天的自己。'].map((text,index)=>({id:`gentle-${index+1}`,text}));
export function quoteText(entry:QuoteEntry){return defaultQuotes.some(builtin=>builtin.id===entry.id&&builtin.text===entry.text)?t(entry.text):entry.text;}
export function useTimerQuote(clock:Snapshot|undefined,entries:QuoteEntry[],enabled:boolean){
  const [selectedId,setSelectedId]=useState(defaultQuotes[0].id);
  const previous=useRef<{status:Snapshot['status'];mode:Snapshot['mode']}|undefined>(undefined);
  const selected=entries.find(entry=>entry.id===selectedId)??entries[0];
  useEffect(()=>{
    if(!clock)return;
    const before=previous.current;
    if(enabled&&entries.length>1&&before?.mode===clock.mode&&clock.status==='running'&&(before.status==='ready'||before.status==='completed')){
      const index=entries.findIndex(entry=>entry.id===selected?.id);setSelectedId(entries[(index+1)%entries.length].id);
    }
    previous.current={status:clock.status,mode:clock.mode};
  },[clock?.status,clock?.mode,entries,enabled,selected?.id]);
  return enabled&&selected?quoteText(selected):'';
}
