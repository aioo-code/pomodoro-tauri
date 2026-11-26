import { t, presetLabel } from '@/lib/i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { savePreferences, usePreferences, type DurationPreset } from '@/lib/preferences';

export function DurationManager({ focusInput = false }: { focusInput?: boolean }) {
  const { values, saving, loaded } = usePreferences();
  const [editing, setEditing] = useState<string>();
  const [label, setLabel] = useState('');
  const [minutes, setMinutes] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const disabled = saving || !loaded;
  useEffect(() => { if (focusInput) { input.current?.scrollIntoView({ block: 'center' }); input.current?.focus({ preventScroll: true }); } }, [focusInput]);
  const clear = () => { setEditing(undefined); setLabel(''); setMinutes(''); setError(''); };
  const edit = (preset: DurationPreset) => { setEditing(preset.id); setLabel(presetLabel(preset)); setMinutes(String(preset.minutes)); setError(''); input.current?.scrollIntoView({ block: 'center' }); input.current?.focus({ preventScroll: true }); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const number = Number(minutes);
    if (!Number.isSafeInteger(number) || number < 1 || number > 1440) { setError('请输入 1–1440 的整数分钟。'); return; }
    if (values.durations.some(preset => preset.id !== editing && preset.minutes === number)) { setError('已经有这个时长，可以直接使用。'); return; }
    if (!editing && values.durations.length >= 24) { setError('最多保存 24 个常用时长。'); return; }
    const entry = { id: editing ?? crypto.randomUUID(), label: label.trim() || t('{minutes}分钟',{minutes:number}), minutes: number };
    const durations = editing ? values.durations.map(preset => preset.id === editing ? entry : preset) : [...values.durations, entry];
    if (await savePreferences({ durations })) clear();
  };
  const move = (index: number, offset: number) => { const durations = [...values.durations]; [durations[index], durations[index + offset]] = [durations[index + offset], durations[index]]; void savePreferences({ durations }); };
  return <section id="duration-manager" className="settings-group" aria-labelledby="durations-heading"><h2 id="durations-heading">{t("常用时长")}</h2>
    <div className="duration-editor">
      <form onSubmit={submit} className="duration-form" noValidate>
        <label className="duration-name-field"><span>{t("名称")}<span className="optional-label">{t("可选")}</span></span><input id="duration-name" value={label} maxLength={20} placeholder={t("例如：阅读")} onChange={event => setLabel(event.target.value)} disabled={disabled}/></label>
        <label className="duration-minute-field"><span>{t("分钟")}</span><input id="duration-minutes" ref={input} type="number" inputMode="numeric" min="1" max="1440" step="1" placeholder="20" value={minutes} onChange={event => setMinutes(event.target.value)} disabled={disabled} aria-invalid={!!error} aria-describedby={error ? 'duration-error' : undefined}/></label>
        <div className="duration-form-actions"><span className="setting-detail">{t("保存后可在主界面选择")}</span>{editing && <Button type="button" id="duration-cancel" size="sm" variant="ghost" onClick={clear}><X/>{t("取消")}</Button>}<Button type="submit" id="duration-save" size="sm" disabled={disabled}>{editing ? <Check/> : <Plus/>}{editing ? t("保存修改") : t("添加时长")}</Button></div>
        {error && <p id="duration-error" role="alert">{t(error)}</p>}
      </form>
      <div className="duration-list" aria-label={t("已保存的时长")}>{values.durations.map((preset, index) => <div className="duration-item" key={preset.id} data-preset-id={preset.id} data-editing={editing === preset.id}><div className="duration-item-label"><span>{presetLabel(preset)}</span><small>{t('{minutes}分钟',{minutes:preset.minutes})}</small></div><div className="duration-item-actions"><Button size="icon" variant="ghost" disabled={disabled || index === 0} aria-label={t('上移{name}',{name:presetLabel(preset)})} onClick={() => move(index, -1)}><ArrowUp/></Button><Button size="icon" variant="ghost" disabled={disabled || index === values.durations.length - 1} aria-label={t('下移{name}',{name:presetLabel(preset)})} onClick={() => move(index, 1)}><ArrowDown/></Button><Button size="icon" variant="ghost" disabled={disabled} aria-label={t('编辑{name}',{name:presetLabel(preset)})} onClick={() => edit(preset)}><Pencil/></Button><Button size="icon" variant="ghost" disabled={disabled} aria-label={t('删除{name}',{name:presetLabel(preset)})} onClick={() => { void savePreferences({ durations: values.durations.filter(item => item.id !== preset.id) }).then(saved => { if (saved && editing === preset.id) clear(); }); }}><Trash2/></Button></div></div>)}</div>
      {!values.durations.length && <p className="empty-durations">{t("还没有常用时长，添加一个吧。")}</p>}
    </div>
  </section>;
}
