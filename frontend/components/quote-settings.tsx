import {useRef,useState,type FormEvent} from 'react';
import {Check,Pencil,Plus,Trash2,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {savePreferences,usePreferences} from '@/lib/preferences';
import {quoteText} from '@/lib/quotes';
import {t} from '@/lib/i18n';
import './quote-settings.css';

export function QuoteSettings(){
  const {values,loaded,saving}=usePreferences();
  const [editing,setEditing]=useState<string>(),[text,setText]=useState(''),[error,setError]=useState('');
  const input=useRef<HTMLTextAreaElement>(null),disabled=!loaded||saving;
  const clear=()=>{setEditing(undefined);setText('');setError('');};
  const submit=async(event:FormEvent)=>{
    event.preventDefault();if(disabled)return;
    let normalized=text.trim().replace(/\s+/gu,' ');
    if(!normalized||Array.from(normalized).length>120){setError('语录请使用 1–120 个字。');return;}
    if(!editing&&values.quotes.length>=50){setError('最多保存 50 条语录。');return;}
    const previous=values.quotes.find(entry=>entry.id===editing);
    if(previous&&normalized===quoteText(previous))normalized=previous.text;
    const entry={id:editing??crypto.randomUUID(),text:normalized};
    const quotes=editing?values.quotes.map(quote=>quote.id===editing?entry:quote):[...values.quotes,entry];
    if(await savePreferences({quotes}))clear();
  };
  return <section id="quote-settings" className="settings-group quote-settings" aria-labelledby="quotes-heading"><h2 id="quotes-heading">{t('格致语录')}</h2>
    <div className="quote-card">
      <label className="quote-toggle-row" htmlFor="setting-quotes"><span><span className="setting-label">{t('显示自律格言')}</span><span className="setting-detail">{t('每段计时换一句，大小窗保持一致')}</span></span><button id="setting-quotes" type="button" role="switch" className="setting-switch" aria-label={t('显示自律格言')} aria-checked={values.quotesEnabled} disabled={disabled} onClick={()=>void savePreferences({quotesEnabled:!values.quotesEnabled})}><span/></button></label>
      <p className="quote-settings-hint">{t('没有语录或关闭显示时，恢复计时状态；提醒始终优先。')}</p>
      <form onSubmit={submit} noValidate className="quote-form"><label htmlFor="quote-text">{t(editing?'编辑语录':'写一句给自己的话')}</label><textarea id="quote-text" ref={input} value={text} rows={2} maxLength={240} placeholder={t('例如：先做好眼前这一小步。')} disabled={disabled} aria-invalid={!!error} aria-describedby={error?'quote-error':undefined} onChange={event=>{setText(event.target.value);setError('');}}/>
        <div className="quote-form-actions"><span className="quote-count">{Array.from(text.trim().replace(/\s+/gu,' ')).length}/120</span><div>{editing&&<Button id="quote-cancel" type="button" variant="ghost" size="sm" onClick={clear}><X/>{t('取消')}</Button>}<Button id="quote-save" type="submit" variant="secondary" size="sm" disabled={disabled||!text.trim()}>{editing?<Check/>:<Plus/>}{t(editing?'保存修改':'添加语录')}</Button></div></div>
        {error&&<p id="quote-error" className="settings-error" role="alert">{t(error)}</p>}
      </form>
      <div className="quote-list" aria-label={t('已保存的语录')}>{values.quotes.map((entry,index)=><div className="quote-item" key={entry.id} data-quote-id={entry.id} data-editing={editing===entry.id}><span className="quote-number" aria-hidden="true">{String(index+1).padStart(2,'0')}</span><p>{quoteText(entry)}</p><div className="quote-item-actions"><Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={t('编辑第 {number} 条语录',{number:index+1})} onClick={()=>{setEditing(entry.id);setText(quoteText(entry));setError('');input.current?.scrollIntoView({block:'center'});input.current?.focus({preventScroll:true});}}><Pencil/></Button><Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={t('删除第 {number} 条语录',{number:index+1})} onClick={()=>void savePreferences({quotes:values.quotes.filter(quote=>quote.id!==entry.id)}).then(saved=>{if(saved&&editing===entry.id)clear();})}><Trash2/></Button></div></div>)}</div>
      {!values.quotes.length&&<p className="quote-settings-hint quote-empty">{t('还没有语录，计时状态会正常显示。')}</p>}
    </div>
  </section>;
}
