import {
  GEMINI_RESPONSE_POLL_INTERVAL_MS,
  GEMINI_RESPONSE_QUIET_WINDOW_MS,
  getGeminiResponseTimeoutMs,
} from './GeminiConstants.js'

type GeminiPageLike = {
  isClosed(): boolean
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>
  waitForTimeout(ms: number): Promise<void>
}

type GeminiResponseSnapshot = {
  latestResponseText: string
  isGenerating: boolean
  fatalErrorReason: string | null
}

export class GeminiResponseWaiter {
  constructor(
    private readonly pollIntervalMs = GEMINI_RESPONSE_POLL_INTERVAL_MS,
    private readonly quietWindowMs = GEMINI_RESPONSE_QUIET_WINDOW_MS,
  ) {}

  async getLatestResponseText(page: GeminiPageLike): Promise<string> {
    const snapshot = await this.readSnapshot(page)
    return snapshot.latestResponseText
  }

  async waitForCompletion(args: {
    page: GeminiPageLike
    signal?: AbortSignal
    timeoutMs?: number
    baselineText?: string
  }): Promise<string> {
    const timeoutMs = args.timeoutMs ?? getGeminiResponseTimeoutMs()
    const deadline = Date.now() + timeoutMs
    const baseline = (args.baselineText ?? '').trim()

    let stableSince = 0
    let latest = baseline

    while (Date.now() < deadline) {
      if (args.signal?.aborted) {
        throw new Error('Gemini Web request aborted')
      }

      if (args.page.isClosed()) {
        throw new Error('Gemini tab was closed before response completed')
      }

      const snapshot = await this.readSnapshot(args.page)
      if (snapshot.fatalErrorReason) {
        throw new Error(
          `Gemini Web returned a fatal page state: ${snapshot.fatalErrorReason}`,
        )
      }

      const text = snapshot.latestResponseText.trim()
      if (text !== latest) {
        latest = text
        stableSince = Date.now()
      } else if (stableSince === 0 && text.length > 0) {
        stableSince = Date.now()
      }

      const hasNewText = text.length > 0 && text !== baseline
      const isStable = stableSince > 0 && Date.now() - stableSince >= this.quietWindowMs
      if (hasNewText && !snapshot.isGenerating && isStable) {
        return text
      }

      await args.page.waitForTimeout(this.pollIntervalMs)
    }

    throw new Error(
      `Timed out waiting for Gemini response completion after ${timeoutMs}ms`,
    )
  }

  private async readSnapshot(page: GeminiPageLike): Promise<GeminiResponseSnapshot> {
    return page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (el as HTMLElement).offsetParent !== null
        )
      }

      const stopSelectors = [
        'button[aria-label*="Stop"]',
        '[data-testid*="stop"]',
      ]

      const modelSelectors = [
        '[data-message-author-role="model"]',
        '.model-response',
        '.response-content',
        '.markdown',
      ]

      const isGenerating = stopSelectors.some(selector =>
        Array.from(document.querySelectorAll(selector)).some(isVisible),
      )

      const responseTexts: string[] = []
      for (const selector of modelSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector))
        for (const node of nodes) {
          const text = (node.textContent ?? '').trim()
          if (text.length > 0) {
            responseTexts.push(text)
          }
        }
      }
      const latestResponseText = responseTexts.at(-1) ?? ''

      const url = window.location.href
      const bodyText = (document.body?.innerText ?? '').toLowerCase()

      let fatalErrorReason: string | null = null
      if (url.includes('accounts.google.com')) {
        fatalErrorReason = 'signin_required'
      } else if (bodyText.includes('something went wrong')) {
        fatalErrorReason = 'page_error'
      } else if (
        bodyText.includes('rate limit') ||
        bodyText.includes('too many requests')
      ) {
        fatalErrorReason = 'rate_limited'
      } else if (bodyText.includes('sign in to gemini')) {
        fatalErrorReason = 'signin_required'
      }

      return {
        latestResponseText,
        isGenerating,
        fatalErrorReason,
      }
    })
  }
}
