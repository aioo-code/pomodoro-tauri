import { t } from '@/lib/i18n';
import type { ReactNode } from 'react';
import { ArrowLeft, Minimize2, Minus, Moon, Pin, PinOff, Settings2, Sun, Volume2, VolumeX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { setTheme, useTheme } from '@/lib/theme';
import type { Desktop } from '@/lib/api';
import { drag } from '@/lib/drag';
import { AppMark } from '@/components/app-mark';
import {playCue} from '@/lib/audio';
import {savePreferences,usePreferences} from '@/lib/preferences';

function IconButton({ label, children, onClick, pressed, id, disabled }: { label: string; children: ReactNode; onClick: () => void; pressed?: boolean; id?: string; disabled?: boolean }) {
  return <Tooltip><TooltipTrigger asChild><Button id={id} variant="ghost" size="icon" className="window-button" aria-label={t(label)} aria-pressed={pressed} onClick={()=>{onClick();if(['settings','settings-back','theme'].includes(id??''))void playCue('select');}} disabled={disabled}>{children}</Button></TooltipTrigger><TooltipContent side="bottom">{t(label)}</TooltipContent></Tooltip>;
}
export function ThemeMenu() {
  const theme = useTheme();
  return <IconButton id="theme" label={theme === 'dark' ? t("切换为浅色") : t("切换为深色")} pressed={theme === 'dark'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun/> : <Moon/>}</IconButton>;
}
export function Titlebar({ desktop, busy, onAction, onSettings, settingsOpen }: { desktop?: Desktop; busy: boolean; onAction: (action: string) => void; onSettings: () => void; settingsOpen: boolean }) {
  const {values,saving,loaded}=usePreferences();
  return <header className="titlebar" onPointerDown={drag} data-drag-handle>
    <div className="brand"><AppMark/><span>{t(settingsOpen?"设置":"番茄时钟")}</span>{settingsOpen&&<span className="sr-only" role="status">{t(saving?"保存中…":"自动保存")}</span>}</div>
    <div className="window-actions" data-no-drag><IconButton id={settingsOpen?"settings-back":"settings"} label={settingsOpen?"返回计时":"设置"} pressed={settingsOpen} onClick={onSettings}>{settingsOpen?<ArrowLeft/>:<Settings2/>}</IconButton><IconButton id="mute" label={values.audioMuted?'取消静音模式':'开启静音模式'} pressed={values.audioMuted} disabled={saving||!loaded} onClick={()=>void savePreferences({audioMuted:!values.audioMuted})}>{values.audioMuted?<VolumeX/>:<Volume2/>}</IconButton><ThemeMenu/>
      <IconButton id="pin" label={desktop?.pinned ? t("取消置顶") : t("置顶窗口")} pressed={desktop?.pinned ?? false} disabled={busy} onClick={() => onAction('pin')}>{desktop?.pinned ? <PinOff/> : <Pin/>}</IconButton>
      <IconButton id="mini" label={t("切换小悬浮窗")} disabled={busy} onClick={() => onAction('mini')}><Minimize2/></IconButton>
      <IconButton id="minimize" label={t("最小化")} disabled={busy} onClick={() => onAction('minimize')}><Minus/></IconButton>
      <IconButton id="hide" label={t("收起到托盘，计时继续")} disabled={busy} onClick={() => onAction('hide')}><X/></IconButton>
    </div>
  </header>;
}
