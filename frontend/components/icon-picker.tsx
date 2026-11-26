import { t } from '@/lib/i18n';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { iconChoices, type IconChoice } from '@/lib/icon-choices';

export function IconPicker({ value, disabled, save }: { value: IconChoice; disabled: boolean; save: (value: IconChoice) => Promise<boolean> }) {
  const select = async (id: IconChoice) => { if (id !== value && await save(id)) document.getElementById(`icon-${id}`)?.focus(); };
  return <div className="setting-block"><span className="setting-label" id="icon-choice-label">{t("应用图标")}</span><span className="setting-detail" id="icon-choice-help">{t("立即应用到任务栏和系统托盘")}</span>
    <div className="icon-choices" role="radiogroup" aria-labelledby="icon-choice-label" aria-describedby="icon-choice-help">{iconChoices.map((icon,index) => <Button key={icon.id} id={`icon-${icon.id}`} variant="ghost" type="button" role="radio" className="icon-choice" aria-label={t('{name}图标',{name:t(icon.label)})} aria-checked={value === icon.id} tabIndex={value === icon.id ? 0 : -1} disabled={disabled} onClick={() => { void select(icon.id); }} onKeyDown={event => {
      const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[event.key];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? iconChoices.length - 1 : offset === undefined ? undefined : (index + offset + iconChoices.length) % iconChoices.length;
      if (next !== undefined) { event.preventDefault(); void select(iconChoices[next].id); }
    }}><img src={icon.image} alt="" draggable={false}/><span>{t(icon.label)}</span>{value === icon.id && <Check className="icon-choice-check" aria-hidden="true"/>}</Button>)}</div>
  </div>;
}
