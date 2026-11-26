import { useSyncExternalStore } from 'react';
import { applyPreferenceColors } from '@/lib/preferences';
import { invoke } from '@/lib/api';
export type Theme = 'light' | 'dark';
export type ThemeChoice = Theme | 'system';
const key = 'pomodoro.theme.v1';
const media = window.matchMedia('(prefers-color-scheme: dark)');
function storedChoice(): ThemeChoice {
  try { const value = localStorage.getItem(key); if (value === 'light' || value === 'dark') return value; } catch { /* Use system appearance when storage is unavailable. */ }
  return 'system';
}
let choice = storedChoice();
let systemTheme: Theme = media.matches ? 'dark' : 'light';
let theme: Theme = choice === 'system' ? systemTheme : choice;
let currentSync = 0, lastAcrylic: string | undefined;
const subscribers = new Set<() => void>();
function render() {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeChoice = choice;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  applyPreferenceColors();
  subscribers.forEach(listener => listener());
}
async function syncMaterial() {
  const request = ++currentSync, requested = choice;
  for (let attempt = 0; attempt < 4 && request === currentSync; attempt++) {
    try {
      // Release the native override for system mode; do not feed WebView's forced scheme back.
      const result = await invoke<{ acrylic: boolean; theme: Theme }>('set_appearance', { theme: requested });
      if (request !== currentSync) return;
      if (requested === 'system') systemTheme = result.theme;
      theme = requested === 'system' ? systemTheme : requested;
      document.documentElement.dataset.material = result.acrylic ? 'acrylic' : 'solid';
      delete document.documentElement.dataset.materialError;
      render();
      return;
    } catch (error) {
      if (request !== currentSync) return;
      document.documentElement.dataset.material = 'fallback';
      document.documentElement.dataset.materialError = String(error);
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
function changed() {
  theme = choice === 'system' ? systemTheme : choice;
  render(); void syncMaterial();
}
window.addEventListener('pomodoro:preferences-synced', () => {
  render();
  const acrylic = document.documentElement.dataset.acrylic;
  if (acrylic !== lastAcrylic) { lastAcrylic = acrylic; void syncMaterial(); }
});
window.addEventListener('storage', event => { if (event.key === key || event.key === null) { choice = storedChoice(); changed(); } });
// A media change is a signal to query native state, never the authoritative system value.
media.addEventListener('change', () => { if (choice === 'system') void syncMaterial(); });
void window.__TAURI__.event.listen<Theme>('system-theme-changed', event => {
  if (event.payload !== 'light' && event.payload !== 'dark') return;
  systemTheme = event.payload;
  if (choice === 'system') changed();
}).catch(error => console.error('System appearance:', error));
render(); lastAcrylic = document.documentElement.dataset.acrylic; void syncMaterial();
export function setTheme(value: ThemeChoice) {
  choice = value;
  try { localStorage.setItem(key, value); } catch { /* Session appearance still works. */ }
  changed();
}
const subscribe = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
export function useThemeChoice() { return useSyncExternalStore(subscribe, () => choice); }
export function useTheme() { return useSyncExternalStore(subscribe, () => theme); }
