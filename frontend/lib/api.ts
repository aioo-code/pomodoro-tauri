export type Mode = 'focus' | 'break';
export type Status = 'ready' | 'running' | 'paused' | 'completed';
export interface Snapshot {
  adjusted: boolean;
  mode: Mode; status: Status; remainingMs: number; durationMs: number;
  revision: number; testMode: boolean; selectedMinutes: number; focusMinutes: number; breakMinutes: number;
}
export interface Reminder { pending: boolean; mode: Mode; revision: number }
export interface Desktop {
  focused: boolean;
  widget: { effectiveOpacity: number; nativeOpacity:number;contentOpacity:number;acrylic:boolean;layered:boolean; dimmed: boolean; dragging: boolean; focused: boolean; pointerInside: boolean; toolWindow: boolean; appWindow: boolean; frame: { x: number; y: number; width: number; height: number } };
  mini: boolean; pinned: boolean; visible: boolean; decorated: boolean;
  width: number; height: number; x: number; y: number; scale: number; outerWidth: number; outerHeight: number; trayAvailable: boolean;
  reminder: Reminder; reminderVisible: boolean;
  reminderX: number; reminderY: number; reminderWidth: number; reminderHeight: number;
  workX: number; workY: number; workWidth: number; workHeight: number;
}
declare global {
  interface Window {
    __TAURI__: {
      core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
      event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
      window: { getCurrentWindow(): { startDragging(): Promise<void>; close(): Promise<void> } };
    };
  }
}
export const invoke = <T,>(command: string, args?: Record<string, unknown>) => window.__TAURI__.core.invoke<T>(command, args);
export const formatTime = (milliseconds: number) => {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
