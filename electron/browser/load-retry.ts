const MAX_BROWSER_LOAD_RETRIES = 5;

export interface BrowserLoadRetryTarget {
  isDestroyed(): boolean;
  load(url: string): Promise<void>;
}

export interface BrowserLoadRetryOptions {
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class BrowserLoadRetry {
  private readonly schedule: NonNullable<BrowserLoadRetryOptions["schedule"]>;
  private readonly cancel: NonNullable<BrowserLoadRetryOptions["cancel"]>;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private url: string | undefined;

  constructor(
    private readonly target: BrowserLoadRetryTarget,
    options: BrowserLoadRetryOptions = {},
  ) {
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
  }

  reset(url?: string): void {
    this.clearTimer();
    this.retries = 0;
    this.url = url;
  }

  loaded(): void {
    this.clearTimer();
    this.retries = 0;
  }

  failed(url?: string): boolean {
    if (url) this.url = url;
    if (!this.url || this.retries >= MAX_BROWSER_LOAD_RETRIES) return false;

    const delayMs = Math.min(1_000 * 2 ** this.retries, 30_000);
    this.retries += 1;
    this.clearTimer();
    this.timer = this.schedule(() => {
      this.timer = undefined;
      const retryUrl = this.url;
      if (!retryUrl || this.target.isDestroyed()) return;
      void this.target.load(retryUrl).catch(() => undefined);
    }, delayMs);
    return true;
  }

  stop(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }
}
