import { describe, expect, it } from 'bun:test'
import { GeminiResponseWaiter } from './GeminiResponseWaiter.js'

type Snapshot = {
  latestResponseText: string
  isGenerating: boolean
  fatalErrorReason: string | null
}

class FakeGeminiPage {
  private index = 0

  constructor(
    private readonly snapshots: Snapshot[],
    private readonly clock: { nowMs: number },
  ) {}

  isClosed(): boolean {
    return false
  }

  async evaluate<T>(_fn: () => T | Promise<T>): Promise<T> {
    const snapshot =
      this.snapshots[Math.min(this.index, this.snapshots.length - 1)] ?? {
        latestResponseText: '',
        isGenerating: false,
        fatalErrorReason: null,
      }
    this.index += 1
    return snapshot as unknown as T
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.clock.nowMs += ms
  }
}

describe('GeminiResponseWaiter', () => {
  it('returns when new text is stable and generation is finished', async () => {
    const clock = { nowMs: 0 }
    const page = new FakeGeminiPage(
      [
        { latestResponseText: 'done', isGenerating: false, fatalErrorReason: null },
        { latestResponseText: 'done', isGenerating: false, fatalErrorReason: null },
        { latestResponseText: 'done', isGenerating: false, fatalErrorReason: null },
      ],
      clock,
    )

    const waiter = new GeminiResponseWaiter(100, 200, 600, () => clock.nowMs)
    const result = await waiter.waitForCompletion({
      page,
      timeoutMs: 1_000,
      baselineText: '',
    })

    expect(result).toBe('done')
  })

  it('returns after sticky window when stop indicator remains visible', async () => {
    const clock = { nowMs: 0 }
    const page = new FakeGeminiPage(
      Array.from({ length: 10 }, () => ({
        latestResponseText: 'still-here',
        isGenerating: true,
        fatalErrorReason: null,
      })),
      clock,
    )

    const waiter = new GeminiResponseWaiter(100, 200, 500, () => clock.nowMs)
    const result = await waiter.waitForCompletion({
      page,
      timeoutMs: 2_000,
      baselineText: '',
    })

    expect(result).toBe('still-here')
    expect(clock.nowMs).toBeGreaterThanOrEqual(500)
  })

  it('throws when page reports a fatal state', async () => {
    const clock = { nowMs: 0 }
    const page = new FakeGeminiPage(
      [
        {
          latestResponseText: '',
          isGenerating: false,
          fatalErrorReason: 'signin_required',
        },
      ],
      clock,
    )

    const waiter = new GeminiResponseWaiter(100, 200, 500, () => clock.nowMs)
    await expect(
      waiter.waitForCompletion({
        page,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('signin_required')
  })
})
