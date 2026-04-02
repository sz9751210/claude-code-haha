import { GEMINI_TAB_MIN_INTERVAL_MS } from './GeminiConstants.js'

type SleepFn = (ms: number) => Promise<void>

const defaultSleep: SleepFn = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

export class GeminiTabRateLimiter {
  private lastTabOpenedAt: number | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly minIntervalMs = GEMINI_TAB_MIN_INTERVAL_MS,
    private readonly now = () => Date.now(),
    private readonly sleepFn: SleepFn = defaultSleep,
  ) {}

  async acquire(): Promise<void> {
    const run = async () => {
      if (this.lastTabOpenedAt !== null) {
        const now = this.now()
        const elapsed = now - this.lastTabOpenedAt
        if (elapsed < this.minIntervalMs) {
          await this.sleepFn(this.minIntervalMs - elapsed)
        }
      }
      this.lastTabOpenedAt = this.now()
    }

    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    await next
  }
}
