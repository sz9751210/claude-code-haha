import { mkdir } from 'fs/promises'
import type { BrowserContext, Page } from 'playwright'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { buildGeminiBootstrapPrompt } from './GeminiBootstrapPrompt.js'
import {
  GEMINI_WEB_HEADLESS_ENV,
  GEMINI_WEB_URL,
  getGeminiProfileDir,
  getGeminiResponseTimeoutMs,
} from './GeminiConstants.js'
import { GeminiResponseWaiter } from './GeminiResponseWaiter.js'
import {
  type GeminiSessionKey,
  GeminiSessionRouter,
} from './GeminiSessionRouter.js'
import { GeminiTabRateLimiter } from './GeminiTabRateLimiter.js'

const PROMPT_INPUT_SELECTORS = [
  'div[role="textbox"][contenteditable="true"][aria-label*="prompt"]',
  'div[role="textbox"][contenteditable="true"][aria-label*="Prompt"]',
  'div[role="textbox"][contenteditable="true"]',
  'textarea[aria-label*="prompt"]',
  'textarea[aria-label*="Gemini"]',
  'textarea',
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"]',
]

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[aria-label*="送出"]',
  'button[aria-label*="傳送"]',
  'button[data-testid*="send"]',
  'button[type="submit"]',
]

const PROMPT_INPUT_DISCOVERY_TIMEOUT_MS = 20_000
const PROMPT_INPUT_RETRY_INTERVAL_MS = 300
const PROMPT_SEND_CONFIRM_TIMEOUT_MS = 8_000
const PROMPT_SEND_CONFIRM_POLL_INTERVAL_MS = 250
const PROMPT_SEND_MAX_ATTEMPTS = 3

const USER_MESSAGE_SELECTORS = [
  '[data-message-author-role="user"]',
  '.user-message',
  '[data-author="user"]',
]

const GENERATING_STOP_SELECTORS = [
  'button[aria-label*="Stop"]',
  'button[aria-label*="stop"]',
  'button[aria-label*="停止"]',
  '[data-testid*="stop"]',
]

function getGeminiHeadless(): boolean {
  return isEnvTruthy(process.env[GEMINI_WEB_HEADLESS_ENV])
}

export class GeminiBrowserPool {
  private contextPromise?: Promise<BrowserContext>
  private readonly rateLimiter = new GeminiTabRateLimiter()
  private readonly sessionRouter = new GeminiSessionRouter<Page>()
  private readonly responseWaiter = new GeminiResponseWaiter()
  private readonly sessionLocks = new Map<GeminiSessionKey, Promise<unknown>>()

  async isSessionInitialized(sessionKey: GeminiSessionKey): Promise<boolean> {
    const session = await this.ensureSession(sessionKey)
    return session.initialized
  }

  async sendPromptAndWait(args: {
    sessionKey: GeminiSessionKey
    prompt: string
    signal?: AbortSignal
    bootstrapPrompt?: string
    timeoutMs?: number
  }): Promise<string> {
    return this.withSessionLock(args.sessionKey, async () => {
      const session = await this.ensureSession(args.sessionKey)
      const timeoutMs = args.timeoutMs ?? getGeminiResponseTimeoutMs()
      const bootstrapPrompt = args.bootstrapPrompt ?? buildGeminiBootstrapPrompt()

      if (!session.initialized) {
        await this.submitPromptAndWait({
          page: session.page,
          prompt: bootstrapPrompt,
          timeoutMs,
          signal: args.signal,
        })
        this.sessionRouter.markInitialized(args.sessionKey)
      }

      return this.submitPromptAndWait({
        page: session.page,
        prompt: args.prompt,
        timeoutMs,
        signal: args.signal,
      })
    })
  }

  async close(): Promise<void> {
    const context = await this.contextPromise
    await context?.close()
    this.contextPromise = undefined
  }

  private async withSessionLock<T>(
    key: GeminiSessionKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLocks.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.sessionLocks.set(key, current.catch(() => undefined))
    return current
  }

  private async ensureSession(key: GeminiSessionKey) {
    const session = await this.sessionRouter.getOrCreate(key, async () => {
      await this.rateLimiter.acquire()
      const context = await this.getContext()
      const page = await context.newPage()
      await page.goto(GEMINI_WEB_URL, { waitUntil: 'domcontentloaded' })
      return page
    })

    if (session.page.isClosed()) {
      this.sessionRouter.remove(key)
      return this.ensureSession(key)
    }

    return session
  }

  private async getContext(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.createContext()
    }
    return this.contextPromise
  }

  private async createContext(): Promise<BrowserContext> {
    const userDataDir = getGeminiProfileDir()
    await mkdir(userDataDir, { recursive: true })

    let playwright: typeof import('playwright')
    try {
      playwright = await import('playwright')
    } catch (error) {
      throw new Error(
        `Gemini Web provider requires Playwright. Install it with "npm install playwright". ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    return playwright.chromium.launchPersistentContext(userDataDir, {
      headless: getGeminiHeadless(),
      viewport: { width: 1440, height: 960 },
      acceptDownloads: false,
    })
  }

  private async submitPromptAndWait(args: {
    page: Page
    prompt: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<string> {
    await this.ensureGeminiUrl(args.page)
    await this.responseWaiter.waitUntilIdle({
      page: args.page,
      signal: args.signal,
      timeoutMs: Math.min(args.timeoutMs, 30_000),
    })
    const baseline = await this.responseWaiter.getLatestResponseText(args.page)
    await this.fillPromptInput(args.page, args.prompt)
    await this.submitPromptWithConfirmation({
      page: args.page,
      prompt: args.prompt,
      signal: args.signal,
    })
    return this.responseWaiter.waitForCompletion({
      page: args.page,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      baselineText: baseline,
    })
  }

  private async ensureGeminiUrl(page: Page): Promise<void> {
    const url = page.url()
    if (
      url.startsWith(GEMINI_WEB_URL) ||
      url.startsWith('https://accounts.google.com/')
    ) {
      return
    }
    await page.goto(GEMINI_WEB_URL, { waitUntil: 'domcontentloaded' })
  }

  private async fillPromptInput(page: Page, prompt: string): Promise<void> {
    const deadline = Date.now() + PROMPT_INPUT_DISCOVERY_TIMEOUT_MS

    while (Date.now() < deadline) {
      const filled = await this.tryFillPromptInput(page, prompt)
      if (filled) {
        return
      }

      await page.waitForTimeout(PROMPT_INPUT_RETRY_INTERVAL_MS)
    }

    const diagnostics = await page
      .evaluate(() => {
        const bodyText = (document.body?.innerText ?? '').toLowerCase()
        const signInDetected =
          bodyText.includes('sign in') || bodyText.includes('登入')

        return {
          url: window.location.href,
          title: document.title,
          signInDetected,
        }
      })
      .catch(() => null)

    const diagnosticMessage = diagnostics
      ? ` (url: ${diagnostics.url}, title: ${diagnostics.title}, signInDetected: ${diagnostics.signInDetected})`
      : ''

    throw new Error(
      `Unable to locate Gemini prompt input after ${PROMPT_INPUT_DISCOVERY_TIMEOUT_MS}ms. Ensure Gemini page is loaded.${diagnosticMessage}`,
    )
  }

  private async tryFillPromptInput(page: Page, prompt: string): Promise<boolean> {
    for (const selector of PROMPT_INPUT_SELECTORS) {
      const candidates = page.locator(selector)
      const count = await candidates.count()
      if (count === 0) {
        continue
      }

      for (let i = 0; i < count; i++) {
        const locator = candidates.nth(i)
        try {
          await locator.waitFor({ state: 'visible', timeout: 1_500 })
          await locator.click({ timeout: 2_500 })

          try {
            await locator.fill('', { timeout: 1_000 })
          } catch {
            // Some Gemini variants expose non-fillable editors; fallback below.
          }

          try {
            await locator.fill(prompt, { timeout: 1_500 })
          } catch {
            // Some Gemini variants expose non-fillable editors; fallback below.
          }

          const filled = await locator.evaluate((node, value) => {
            if (
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLInputElement
            ) {
              node.value = value
              node.dispatchEvent(new Event('input', { bubbles: true }))
              node.dispatchEvent(new Event('change', { bubbles: true }))
              return node.value.includes(value)
            }

            if (node instanceof HTMLElement && node.isContentEditable) {
              node.textContent = value
              node.dispatchEvent(new Event('beforeinput', { bubbles: true }))
              node.dispatchEvent(new Event('input', { bubbles: true }))
              return (node.textContent ?? '').includes(value)
            }

            return false
          }, prompt)

          if (filled) {
            return true
          }
        } catch {
          continue
        }
      }
    }

    return false
  }

  private async submitPromptWithConfirmation(args: {
    page: Page
    prompt: string
    signal?: AbortSignal
  }): Promise<void> {
    const baseline = await this.readSubmissionSnapshot(args.page, args.prompt)
    for (let attempt = 0; attempt < PROMPT_SEND_MAX_ATTEMPTS; attempt++) {
      await this.submitPromptAttempt(args.page, attempt)
      const confirmed = await this.waitForPromptSubmissionConfirmation({
        page: args.page,
        prompt: args.prompt,
        baseline,
        signal: args.signal,
      })
      if (confirmed) {
        return
      }
    }

    throw new Error(
      'Prompt submission could not be confirmed. Gemini input may still contain unsent text.',
    )
  }

  private async submitPromptAttempt(page: Page, attempt: number): Promise<void> {
    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = page.locator(selector).first()
      if ((await button.count()) === 0) {
        continue
      }
      try {
        await button.waitFor({ state: 'visible', timeout: 1_500 })
        if (await button.isDisabled()) {
          continue
        }
        await button.click({ timeout: 2_500 })
        return
      } catch {
        continue
      }
    }

    if (attempt === 0) {
      await page.keyboard.press('Enter')
      return
    }
    if (attempt === 1) {
      await page.keyboard.press('Meta+Enter')
      return
    }
    await page.keyboard.press('Control+Enter')
  }

  private async waitForPromptSubmissionConfirmation(args: {
    page: Page
    prompt: string
    baseline: {
      userMessageCount: number
      hasPromptInComposer: boolean
      isGenerating: boolean
    }
    signal?: AbortSignal
  }): Promise<boolean> {
    const deadline = Date.now() + PROMPT_SEND_CONFIRM_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (args.signal?.aborted) {
        throw new Error('Gemini Web request aborted')
      }

      const snapshot = await this.readSubmissionSnapshot(args.page, args.prompt)

      const userMessageAdvanced =
        snapshot.userMessageCount > args.baseline.userMessageCount
      const composerCleared =
        args.baseline.hasPromptInComposer && !snapshot.hasPromptInComposer
      const generationStarted =
        !args.baseline.isGenerating && snapshot.isGenerating

      if (userMessageAdvanced || composerCleared || generationStarted) {
        return true
      }

      await args.page.waitForTimeout(PROMPT_SEND_CONFIRM_POLL_INTERVAL_MS)
    }

    return false
  }

  private async readSubmissionSnapshot(
    page: Page,
    prompt: string,
  ): Promise<{
    userMessageCount: number
    hasPromptInComposer: boolean
    isGenerating: boolean
  }> {
    const preview = prompt.trim().slice(0, 120)
    const promptInputSelectors = PROMPT_INPUT_SELECTORS
    const userMessageSelectors = USER_MESSAGE_SELECTORS
    const stopSelectors = GENERATING_STOP_SELECTORS

    return page.evaluate(
      ({ preview, promptInputSelectors, userMessageSelectors, stopSelectors }) => {
        const normalize = (text: string): string =>
          text.replace(/\s+/g, ' ').trim()

        const isVisible = (el: Element): boolean => {
          const style = window.getComputedStyle(el)
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (el as HTMLElement).offsetParent !== null
          )
        }

        const normalizedPreview = normalize(preview)

        const getComposerText = (): string => {
          for (const selector of promptInputSelectors) {
            const nodes = Array.from(document.querySelectorAll(selector))
            for (const node of nodes) {
              if (!isVisible(node)) {
                continue
              }
              if (
                node instanceof HTMLInputElement ||
                node instanceof HTMLTextAreaElement
              ) {
                return node.value ?? ''
              }
              return node.textContent ?? ''
            }
          }
          return ''
        }

        const userMessages: string[] = []
        for (const selector of userMessageSelectors) {
          const nodes = Array.from(document.querySelectorAll(selector))
          for (const node of nodes) {
            if (!isVisible(node)) {
              continue
            }
            const text = normalize(node.textContent ?? '')
            if (text.length > 0) {
              userMessages.push(text)
            }
          }
        }

        const isGenerating = stopSelectors.some(selector =>
          Array.from(document.querySelectorAll(selector)).some(isVisible),
        )

        const composerText = normalize(getComposerText())
        const hasPromptInComposer =
          normalizedPreview.length > 0 && composerText.includes(normalizedPreview)

        return {
          userMessageCount: userMessages.length,
          hasPromptInComposer,
          isGenerating,
        }
      },
      {
        preview,
        promptInputSelectors,
        userMessageSelectors,
        stopSelectors,
      },
    )
  }

}

let sharedPool: GeminiBrowserPool | undefined

export function getGeminiBrowserPool(): GeminiBrowserPool {
  sharedPool ??= new GeminiBrowserPool()
  return sharedPool
}
