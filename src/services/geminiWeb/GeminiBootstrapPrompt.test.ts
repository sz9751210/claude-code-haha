import { describe, expect, it } from 'bun:test'
import { buildGeminiBootstrapPrompt } from './GeminiBootstrapPrompt.js'

describe('GeminiBootstrapPrompt', () => {
  it('includes an explicit bootstrap acknowledgment payload', () => {
    const prompt = buildGeminiBootstrapPrompt()

    expect(prompt).toContain('Acknowledge this bootstrap request now.')
    expect(prompt).toContain(
      '{"type":"assistant_turn","tool_calls":[],"final_text":"BOOTSTRAP_OK"}',
    )
  })
})
