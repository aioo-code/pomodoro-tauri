import { t, languages } from '@/lib/i18n';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {invoke} from '@/lib/api';
import { Monitor, Moon, Play, RotateCcw, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import { defaults, savePreferences, usePreferences, type Position } from '@/lib/preferences';
import { setTheme, useThemeChoice, type ThemeChoice } from '@/lib/theme';
import { DurationManager } from '@/components/durations';
import { SettingRange } from '@/components/setting-range';
import { IconPicker } from '@/components/icon-picker';
import {AudioSettings} from '@/components/audio-settings';
import {QuoteSettings} from '@/components/quote-settings';
import {playCue} from '@/lib/audio';
import {ThemePalette} from '@/components/theme-palette';
import GradualBlur from '@/components/reactbits/GradualBlur';
import {useReducedMotion} from '@/hooks/use-reduced-motion';
import {useScrollFeather,settingsScrollEdges} from '@/hooks/use-scroll-feather';
import {ScrollArea} from 'radix-ui';

const positions: { id: Position; label: string }[] = [
  { id: 'top-left', label: '左上角' }, { id: 'top-right', label: '右上角' },
  { id: 'center', label: '屏幕居中' },
  { id: 'bottom-left', label: '左下角' }, { id: 'bottom-right', label: '右下角' },
];
function Switch({ id, label, detail, checked, disabled, onChange }: { id: string; label: string; detail?: string; checked: boolean; disabled: boolean; onChange: () => void }) {
  return <label className="setting-row" htmlFor={id}><span><span className="setting-label">{label}</span>{detail && <span className="setting-detail">{detail}</span>}</span><button id={id} type="button" role="switch" className="setting-switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onChange}><span/></button></label>;
}
export function Settings({ onClose, durationFocus = false }: { onClose: () => void; durationFocus?: boolean }) {
  const { values, saving, loaded, error } = usePreferences();
  const theme = useThemeChoice();
  const [version,setVersion]=useState('');
  useEffect(()=>{let live=true;void invoke<string>('app_version').then(value=>{if(live)setVersion(value);}).catch(()=>{});return()=>{live=false;};},[]);
  const title = useRef<HTMLHeadingElement>(null);
  const scroller=useRef<HTMLDivElement>(null),reducedMotion=useReducedMotion();
  useScrollFeather(scroller);
  const disabled = saving || !loaded;
  useEffect(() => { if (!durationFocus) title.current?.focus(); }, [durationFocus]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return <section id="settings-panel" className="settings-view" aria-label={t("设置")}>
    <h1 ref={title} id="settings-title" className="sr-only" tabIndex={-1}>{t("设置")}</h1>
    <ScrollArea.Root className="settings-viewport" type="auto" scrollHideDelay={600}>
    <ScrollArea.Viewport ref={scroller} className="settings-scroll"><div className="settings-scroll-content">
      <div className="setting-row language-row"><span><span id="language-setting-label" className="setting-label">{t('语言')}</span><span className="setting-detail">{t('即时切换，自动保存')}</span></span><Select value={values.language} disabled={disabled} onValueChange={language => {void savePreferences({language:language as typeof values.language}).then(saved => {if(saved)requestAnimationFrame(()=>document.getElementById('setting-language')?.focus());});}}><SelectTrigger id="setting-language" aria-labelledby="language-setting-label"><SelectValue/></SelectTrigger><SelectContent>{languages.map(item => <SelectItem key={item.id} value={item.id} lang={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
      <section className="settings-group" aria-labelledby="appearance-heading"><h2 id="appearance-heading">{t("外观")}</h2>
        <IconPicker value={values.icon} disabled={disabled} save={icon => savePreferences({ icon })}/>
        <div className="setting-block"><span className="setting-label">{t("主题色")}</span><ThemePalette/></div>
        <div className="setting-block"><span className="setting-label">{t("明暗模式")}</span><div className="appearance-options" role="group" aria-label={t("明暗模式")}>{([{ id: 'light', label: t("浅色"), icon: Sun }, { id: 'dark', label: t("深色"), icon: Moon }, { id: 'system', label: t("跟随系统"), icon: Monitor }] as const).map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" aria-pressed={theme === id} onClick={() => {setTheme(id as ThemeChoice);void playCue('select');}}><Icon/>{label}</Button>)}</div></div>
        <SettingRange id="setting-radius" label={t("界面圆角")} min={0} max={32} value={values.cornerRadius} disabled={disabled} format={value => value === 0 ? t("直角") : String(value)} left={t("0 · 直角")} right={t("32 · 圆润")} save={cornerRadius => savePreferences({ cornerRadius })} onPreview={value => { document.documentElement.style.setProperty('--corner', `${value}px`); document.documentElement.style.setProperty('--corner-sm', `${value * .6}px`); document.documentElement.style.setProperty('--corner-xs', `${value * .35}px`); }}/>
        <p className="widget-menu-hint">{t("控件圆角可精细调节；外窗使用系统圆角档位。")}</p>
        <Switch id="setting-acrylic" label={t("亚克力磨砂玻璃")} detail={t("开启背景模糊；系统不支持时自动使用实色背景")} checked={values.acrylic} disabled={disabled} onChange={() => void savePreferences({ acrylic: !values.acrylic })}/>
      </section>
      <AudioSettings/>
      <DurationManager focusInput={durationFocus}/>
      <section className="settings-group" aria-labelledby="window-heading"><h2 id="window-heading">{t("窗口")}</h2>
        <div className="setting-row position-row"><div><span className="setting-label">{t("主窗位置")}</span><span className="setting-detail">{t(positions.find(position => position.id === values.position)?.label ?? '')}{t("· 选择后立即移动")}</span></div><div className="position-grid" role="group" aria-label={t("主窗位置")}>{positions.map(position => <button type="button" key={position.id} className={`position-choice position-${position.id}`} title={t(position.label)} aria-label={t(position.label)} aria-pressed={values.position === position.id} disabled={disabled} onClick={() => void savePreferences({ position: position.id })}><span/></button>)}</div></div>
        <Switch id="setting-pin" label={t("默认置顶")} detail={t("也可在标题栏快速切换")} checked={values.alwaysOnTop} disabled={disabled} onChange={() => void savePreferences({ alwaysOnTop: !values.alwaysOnTop })}/>
        <Switch id="setting-widget-snap" label={t("窗口贴边吸附")} detail={t("靠近屏幕边缘后松手，吸附并保留边距")} checked={values.snapToEdges} disabled={disabled} onChange={() => void savePreferences({ snapToEdges: !values.snapToEdges })}/>
      </section>
      <section className="settings-group" aria-labelledby="widget-heading"><h2 id="widget-heading">{t("小窗")}</h2>
        <SettingRange id="setting-widget-opacity" label={t("小窗不透明度")} min={30} max={100} value={values.miniOpacity} disabled={disabled} format={value => `${value}%`} left={t("更通透")} right={t("更清晰")} save={miniOpacity => savePreferences({ miniOpacity })} preview={value => <div className="widget-preview" aria-hidden="true"><div className="widget-preview-content" style={{ opacity: value / 100 }}><span>25:00</span><i><Play/></i></div></div>}/>
        <Switch id="setting-widget-dim" label={t("小窗失焦淡化")} detail={t("悬停、触摸或操作时恢复清晰")} checked={values.dimInactive} disabled={disabled} onChange={() => void savePreferences({ dimInactive: !values.dimInactive })}/>
      </section>
      {values.acrylic&&<p className="widget-menu-hint">{t("磨砂模式保留背景模糊，透明度调整内容与表面色调。")}</p>}
      <p className="widget-menu-hint">{t("右键或长按小窗时间，可快速调整不透明度。")}</p>
      <section className="settings-group" aria-labelledby="experience-heading"><h2 id="experience-heading">{t("体验")}</h2>
        <Switch id="setting-number-animation" label={t('数字滚动效果')} detail={t('随计时轻柔滚动，减少动效时自动关闭')} checked={values.numberAnimation} disabled={disabled} onChange={() => void savePreferences({numberAnimation: !values.numberAnimation})}/>
        <Switch id="setting-motion" label={t("减少动效")} detail={t("系统的减少动态效果设置始终生效")} checked={values.reduceMotion} disabled={disabled} onChange={() => void savePreferences({ reduceMotion: !values.reduceMotion })}/>
      </section>
      {error && <p className="settings-error" role="alert">{t(error)}</p>}
      <QuoteSettings/>
      <Button id="settings-reset" variant="ghost" className="settings-reset" disabled={disabled} onClick={() => { void savePreferences({...defaults,quotes:values.quotes}).then(saved => { if (saved) setTheme('system'); }); }}><RotateCcw/>{t("恢复默认设置")}</Button>
      {version&&<p className="settings-version"><span>{t('版本')}</span><span id="app-version">{version}</span></p>}
    </div></ScrollArea.Viewport>
    <ScrollArea.Scrollbar className="settings-scrollbar" orientation="vertical"><ScrollArea.Thumb className="settings-scroll-thumb"/></ScrollArea.Scrollbar>
    <GradualBlur position="top" height={settingsScrollEdges.top} strength={2/3} layers={1} curve="ease-out" autoHide container={scroller} duration={reducedMotion?0:.16} zIndex={2} className="settings-edge-blur"/>
    <GradualBlur position="bottom" height={settingsScrollEdges.bottom} strength={2/3} layers={1} curve="ease-out" autoHide container={scroller} duration={reducedMotion?0:.16} zIndex={2} className="settings-edge-blur"/>
    </ScrollArea.Root>
  </section>;
}
