import type { PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@/lib/api';
import { DragQueue } from './drag-queue';
let activePointer: number | undefined;
const queue = new DragQueue(frame => invoke('drag_update', { ...frame }), error => console.error('Window drag:', error));
const nativeDrag = () => void queue.whenIdle().then(() => invoke('native_drag')).catch(error => console.error('Native window drag:', error));
export function drag(event: ReactPointerEvent<HTMLElement>, onTap?: () => void) {
  const control = (event.target as Element).closest('button, input, [data-no-drag]');
  if (!event.isPrimary || event.button !== 0 || activePointer !== undefined || (control && !(onTap && control === event.currentTarget))) return;
  event.preventDefault();
  event.stopPropagation();
  // Windows owns mouse movement, independent of WebView rendering and IPC frames.
  if (event.pointerType === 'mouse' && !onTap) { nativeDrag(); return; }
  const element = event.currentTarget, pointer = event.pointerId;
  activePointer = pointer;
  const start = { x: event.screenX, y: event.screenY };
  let latest = start, moved = false, ended = false, sequence = 0;
  const gesture = crypto.randomUUID(), abort = new AbortController();
  let longPress: ReturnType<typeof setTimeout> | undefined;
  element.setPointerCapture(pointer);
  const send = (finish: boolean, cancelled: boolean) => queue.push({ gesture, sequence: ++sequence, startX: start.x, startY: start.y, x: latest.x, y: latest.y, finish, cancelled });
  const move = (next: PointerEvent) => {
    if (ended || next.pointerId !== pointer) return;
    const samples = next.getCoalescedEvents?.();
    const point = samples?.length ? samples[samples.length - 1] : next;
    if (point.screenX === latest.x && point.screenY === latest.y) return;
    latest = { x: point.screenX, y: point.screenY };
    if (!moved && Math.hypot(latest.x - start.x, latest.y - start.y) < (next.pointerType === 'touch' ? 4 : 2)) return;
    moved = true; clearTimeout(longPress);
    if (event.pointerType === 'mouse') { cleanup(); nativeDrag(); return; }
    send(false, false);
  };
  const cleanup = () => { ended = true; activePointer = undefined; abort.abort(); clearTimeout(longPress); if (element.hasPointerCapture(pointer)) element.releasePointerCapture(pointer); };
  const finish = (next: PointerEvent) => {
    if (ended || next.pointerId !== pointer) return;
    const cancelled = next.type !== 'pointerup';
    if (!cancelled) latest = { x: next.screenX, y: next.screenY };
    cleanup(); if (moved) send(true, cancelled); else if (!cancelled) onTap?.();
  };
  element.addEventListener('pointerrawupdate', move as EventListener, { signal: abort.signal });
  element.addEventListener('pointermove', move, { signal: abort.signal });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(name, finish as EventListener, { signal: abort.signal });
  if (event.pointerType === 'touch' && document.body.classList.contains('mini')) longPress = setTimeout(() => { if (ended || moved) return; cleanup(); void invoke('widget_menu', { x: event.clientX, y: event.clientY }); }, 500);
}
