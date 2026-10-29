/** Optional request limiter: halve on two consecutive 429s, recover one slot after five successes. */
export class AdaptiveConcurrency {
  private active = 0;
  private busy = 0;
  private healthy = 0;
  private waiters: (() => void)[] = [];
  limit: number;
  constructor(readonly maximum: number) { this.limit = Math.max(1, Math.floor(maximum)); }

  response(status: number): void {
    if (status === 429) {
      this.healthy = 0;
      if (++this.busy >= 2) { this.limit = Math.max(1, Math.floor(this.limit / 2)); this.busy = 0; }
    } else {
      this.busy = 0;
      if (status >= 200 && status < 300) {
        if (++this.healthy >= 5) { this.limit = Math.min(this.maximum, this.limit + 1); this.healthy = 0; }
      } else this.healthy = 0;
    }
    this.wake();
  }

  private wake(): void { for (const waiter of [...this.waiters]) waiter(); }

  private acquire(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters = this.waiters.filter(waiter => waiter !== attempt);
        signal.removeEventListener('abort', attempt);
      };
      const attempt = () => {
        if (signal.aborted) { cleanup(); reject(signal.reason); }
        else if (this.active < this.limit) { cleanup(); this.active++; resolve(); }
      };
      this.waiters.push(attempt);
      signal.addEventListener('abort', attempt, { once: true });
      attempt();
    });
  }

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try { signal.throwIfAborted(); return await operation(); }
    finally { this.active--; this.wake(); }
  }
}
