import { describe, expect, it } from 'bun:test'
import { GeminiTabRateLimiter } from './GeminiTabRateLimiter.js'

describe('GeminiTabRateLimiter', () => {
  it('enforces at least 5 seconds between new tab opens', async () => {
    let now = 100
    const sleeps: number[] = []
    const limiter = new GeminiTabRateLimiter(
      5_000,
      () => now,
      async ms => {
        sleeps.push(ms)
        now += ms
      },
    )

    await limiter.acquire()
    expect(sleeps).toEqual([])

    await limiter.acquire()
    expect(sleeps).toEqual([5_000])

    now += 3_000
    await limiter.acquire()
    expect(sleeps).toEqual([5_000, 2_000])
  })
})
