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
  'button[data-testid*="send"]',
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
    await this.assertSignedIn(args.page)
    const baseline = await this.responseWaiter.getLatestResponseText(args.page)
    await this.fillPromptInput(args.page, args.prompt)
    await this.submitPrompt(args.page)
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
          const filled = await locator.evaluate((node, value) => {
            if (
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLInputElement
            ) {
              node.value = value
              node.dispatchEvent(new Event('input', { bubbles: true }))
              node.dispatchEvent(new Event('change', { bubbles: true }))
              return node.value.trim().length > 0
            }

            if (node instanceof HTMLElement && node.isContentEditable) {
              node.textContent = value
              node.dispatchEvent(new Event('beforeinput', { bubbles: true }))
              node.dispatchEvent(new Event('input', { bubbles: true }))
              return (node.textContent ?? '').trim().length > 0
            }

            return false
          }, prompt)

          if (filled) {
            return
          }
        } catch {
          continue
        }
      }
    }

    const signInDetected = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('a,button'))
      return nodes.some(node => {
        const text = (node.textContent ?? '').toLowerCase()
        const aria = (node.getAttribute('aria-label') ?? '').toLowerCase()
        return text.includes('sign in') || aria.includes('sign in')
      })
    })

    if (signInDetected) {
      throw new Error(
        'Gemini Web sign-in required. Complete one-time login in the configured profile and retry.',
      )
    }

    throw new Error(
      'Unable to locate Gemini prompt input. Ensure Gemini page is loaded and logged in.',
    )
  }

  private async assertSignedIn(page: Page): Promise<void> {
    const signInDetected = await page.evaluate(() => {
      const signInLink = document.querySelector(
        'a[aria-label="Sign in"], a[href*="accounts.google.com/ServiceLogin"]',
      )
      if (signInLink) {
        return true
      }

      const buttons = Array.from(document.querySelectorAll('button,a'))
      return buttons.some(node => {
        const text = (node.textContent ?? '').trim().toLowerCase()
        const aria = (node.getAttribute('aria-label') ?? '').trim().toLowerCase()
        return text === 'sign in' || aria === 'sign in'
      })
    })

    if (signInDetected) {
      throw new Error(
        'Gemini Web sign-in required. Complete one-time login in the configured profile and retry.',
      )
    }
  }

  private async submitPrompt(page: Page): Promise<void> {
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

    await page.keyboard.press('Enter')
  }
}

let sharedPool: GeminiBrowserPool | undefined

export function getGeminiBrowserPool(): GeminiBrowserPool {
  sharedPool ??= new GeminiBrowserPool()
  return sharedPool
}
