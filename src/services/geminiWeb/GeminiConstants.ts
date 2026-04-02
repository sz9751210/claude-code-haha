import os from 'os'
import path from 'path'

export const GEMINI_WEB_URL = 'https://gemini.google.com/'

export const GEMINI_TAB_MIN_INTERVAL_MS = 5_000

export const GEMINI_PROTOCOL_MAX_REPAIR_ATTEMPTS = 3

export const GEMINI_RESPONSE_POLL_INTERVAL_MS = 750
export const GEMINI_RESPONSE_QUIET_WINDOW_MS = 1_500

export const GEMINI_DEFAULT_RESPONSE_TIMEOUT_MS = 120_000

export const GEMINI_WEB_PROFILE_DIR_ENV = 'GEMINI_WEB_PROFILE_DIR'
export const GEMINI_WEB_HEADLESS_ENV = 'GEMINI_WEB_HEADLESS'

export function getGeminiResponseTimeoutMs(): number {
  const raw = process.env.GEMINI_WEB_RESPONSE_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : GEMINI_DEFAULT_RESPONSE_TIMEOUT_MS
}

export function getGeminiProfileDir(): string {
  const configured = process.env[GEMINI_WEB_PROFILE_DIR_ENV]
  if (configured && configured.trim().length > 0) {
    return configured
  }
  return path.join(os.homedir(), '.claude-code-haha', 'gemini-web-profile')
}
