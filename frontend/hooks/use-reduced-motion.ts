import { useSyncExternalStore } from 'react';
import { usePreferences } from '@/lib/preferences';
const query = window.matchMedia('(prefers-reduced-motion: reduce)');
const subscribe = (listener: () => void) => {
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};
// Read the live preference, including changes made after this window has opened.
export function useReducedMotion() {
  const { values } = usePreferences();
  const system = useSyncExternalStore(subscribe, () => query.matches);
  return system || values.reduceMotion;
}
