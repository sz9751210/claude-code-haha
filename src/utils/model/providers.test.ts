import { afterEach, describe, expect, it } from 'bun:test'
import { getAPIProvider } from './providers.js'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_GEMINI_WEB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

const ORIGINAL = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('getAPIProvider', () => {
  it('defaults to firstParty', () => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
    expect(getAPIProvider()).toBe('firstParty')
  })

  it('routes to geminiWeb only when explicitly enabled', () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    process.env.CLAUDE_CODE_USE_GEMINI_WEB = '1'

    expect(getAPIProvider()).toBe('geminiWeb')
  })

  it('gives geminiWeb highest precedence over other providers', () => {
    process.env.CLAUDE_CODE_USE_GEMINI_WEB = '1'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'

    expect(getAPIProvider()).toBe('geminiWeb')
  })
})
