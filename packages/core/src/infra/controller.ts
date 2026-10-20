export type ControllerStatus = "running" | "paused" | "cancelled" | "timed_out";
export type CancelReason = "cancelled" | "timeout";

export class RunController {
  private readonly abort = new AbortController();
  private paused = false;
  private reason: CancelReason | null = null;
  private waiters: Array<() => void> = [];

  get signal(): AbortSignal {
    return this.abort.signal;
  }
  get cancelReason(): CancelReason | null {
    return this.reason;
  }
  get status(): ControllerStatus {
    if (this.reason === "timeout") return "timed_out";
    if (this.reason === "cancelled") return "cancelled";
    return this.paused ? "paused" : "running";
  }

  pause(): void {
    if (this.reason === null) this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.flush();
  }

  cancel(reason: CancelReason): void {
    if (this.reason !== null) return;
    this.reason = reason;
    this.paused = false;
    this.abort.abort(reason);
    this.flush();
  }

  waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private flush(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}
