export interface DragFrame {
  gesture: string; sequence: number; startX: number; startY: number;
  x: number; y: number; finish: boolean; cancelled: boolean;
}

// One request in flight, one latest position waiting. Terminal frames preserve
// gesture order, including a new press before the previous release is acknowledged.
export class DragQueue {
  private frames: DragFrame[] = [];
  private sending = false;
  private waiters: (() => void)[] = [];
  constructor(private send: (frame: DragFrame) => Promise<unknown>, private onError: (error: unknown) => void) {}
  push(frame: DragFrame) {
    const last = this.frames.at(-1);
    if (last && last.gesture === frame.gesture && !last.finish) this.frames[this.frames.length - 1] = frame;
    else this.frames.push(frame);
    void this.flush();
  }
  whenIdle(): Promise<void> { return !this.sending && !this.frames.length ? Promise.resolve() : new Promise(resolve => this.waiters.push(resolve)); }
  private async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.frames.length) {
        const frame = this.frames.shift()!;
        try { await this.send(frame); } catch (error) { this.onError(error); }
      }
    } finally { this.sending = false; this.waiters.splice(0).forEach(resolve => resolve()); }
  }
}
