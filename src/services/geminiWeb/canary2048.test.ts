import { describe, expect, it } from 'bun:test'
import { parseGeminiAssistantTurn } from './GeminiProtocol.js'

describe('Gemini Web canary', () => {
  it('accepts large non-streaming final text payloads', () => {
    const largeText = 'x'.repeat(2_048)
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [],
        final_text: largeText,
      }),
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.final_text.length).toBe(2_048)
    }
  })
})
