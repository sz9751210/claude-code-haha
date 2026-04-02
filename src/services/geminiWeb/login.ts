import { mkdir } from 'fs/promises'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'process'
import { GEMINI_WEB_URL, getGeminiProfileDir } from './GeminiConstants.js'

async function isSignInRequired(
  page: import('playwright').Page,
): Promise<boolean> {
  return page.evaluate(() => {
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
}

async function run(): Promise<void> {
  const profileDir = getGeminiProfileDir()
  await mkdir(profileDir, { recursive: true })

  let playwright: typeof import('playwright')
  try {
    playwright = await import('playwright')
  } catch (error) {
    throw new Error(
      `Playwright is required. Install dependencies first. ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const context = await playwright.chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 960 },
  })

  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(GEMINI_WEB_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.bringToFront()
  await page.waitForTimeout(1_500)

  const alreadySignedIn = !(await isSignInRequired(page))
  if (alreadySignedIn) {
    stdout.write(
      `Gemini Web profile is already signed in.\nProfile: ${profileDir}\n`,
    )
    await context.close()
    return
  }

  stdout.write(
    [
      'Open browser session started for Gemini Web login.',
      `Profile: ${profileDir}`,
      'Complete Google sign-in in the opened browser window.',
      'Then return here and press Enter to verify, or type q + Enter to quit.',
      '',
    ].join('\n'),
  )

  const rl = readline.createInterface({ input: stdin, output: stdout })
  let success = false
  try {
    while (true) {
      const answer = await rl.question('login> ')
      if (answer.trim().toLowerCase() === 'q') {
        break
      }

      await page.goto(GEMINI_WEB_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      })
      await page.waitForTimeout(1_500)

      const stillNeedsSignIn = await isSignInRequired(page)
      if (!stillNeedsSignIn) {
        success = true
        stdout.write('Gemini Web login verified and saved to profile.\n')
        break
      }

      stdout.write('Sign-in not detected yet. Finish login in browser and retry.\n')
    }
  } finally {
    rl.close()
    await context.close()
  }

  if (!success) {
    process.exitCode = 1
  }
}

run().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Gemini Web login helper failed: ${message}`)
  process.exitCode = 1
})
