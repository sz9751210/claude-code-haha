import { describe, expect, it } from 'bun:test'
import {
  buildGeminiTurnPrompt,
  parseGeminiAssistantTurn,
} from './GeminiProtocol.js'

describe('GeminiProtocol', () => {
  it('parses final-text turns', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [],
        final_text: 'done',
      }),
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tool_calls.length).toBe(0)
      expect(parsed.value.final_text).toBe('done')
    }
  })

  it('parses multiple tool calls in one turn', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [
          { id: 'call_1', name: 'Bash', input: { cmd: 'pwd' } },
          { id: 'call_2', name: 'Read', input: { file_path: 'README.md' } },
        ],
        final_text: '',
      }),
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tool_calls.length).toBe(2)
      expect(parsed.value.tool_calls[0]?.name).toBe('Bash')
      expect(parsed.value.tool_calls[1]?.name).toBe('Read')
    }
  })

  it('rejects unknown tool names when allowed list is provided', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [{ id: 'call_1', name: 'UnknownTool', input: {} }],
        final_text: '',
      }),
      {
        allowedToolNames: new Set(['Bash']),
      },
    )

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain('not an allowed tool')
    }
  })

  it('normalizes case-insensitive tool names to allowed names', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [{ id: 'call_1', name: 'bash', input: { cmd: 'pwd' } }],
        final_text: '',
      }),
      {
        allowedToolNames: new Set(['Bash']),
      },
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tool_calls[0]?.name).toBe('Bash')
    }
  })

  it('normalizes aliased tool names to allowed names', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [
          { id: 'call_1', name: 'execute_command', input: { cmd: 'pwd' } },
        ],
        final_text: '',
      }),
      {
        allowedToolNames: new Set(['Bash']),
      },
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tool_calls[0]?.name).toBe('Bash')
    }
  })

  it('normalizes run_terminal_command alias to Bash', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [
          { id: 'call_1', name: 'run_terminal_command', input: { cmd: 'pwd' } },
        ],
        final_text: '',
      }),
      {
        allowedToolNames: new Set(['Bash']),
      },
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tool_calls[0]?.name).toBe('Bash')
    }
  })

  it('accepts Task-style names when allowed tool is Agent', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [{ id: 'call_1', name: 'Task', input: { prompt: 'x' } }],
        final_text: '',
      }),
      {
        allowedToolNames: new Set(['Agent']),
      },
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tool_calls[0]?.name).toBe('Agent')
    }
  })

  it('handles non-string entries in allowed tool names without throwing', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [{ id: 'call_1', name: 'bash', input: { cmd: 'pwd' } }],
        final_text: '',
      }),
      {
        allowedToolNames: new Set(['Bash', undefined as unknown as string]),
      },
    )

    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.tool_calls[0]?.name).toBe('Bash')
    }
  })

  it('rejects empty final_text when no tool calls are present', () => {
    const parsed = parseGeminiAssistantTurn(
      JSON.stringify({
        type: 'assistant_turn',
        tool_calls: [],
        final_text: '  ',
      }),
    )

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain('final_text must be non-empty')
    }
  })

  it('parses JSON from fenced output', () => {
    const parsed = parseGeminiAssistantTurn(
      [
        '```json',
        '{"type":"assistant_turn","tool_calls":[],"final_text":"ok"}',
        '```',
      ].join('\n'),
    )

    expect(parsed.ok).toBe(true)
  })

  it('builds a compact turn prompt with bounded context', () => {
    const prompt = buildGeminiTurnPrompt({
      systemPrompt: 'x'.repeat(3_000),
      conversation: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
      tools: [
        {
          name: 'Bash',
          description: 'run shell',
          input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      ],
    })

    expect(prompt).toContain('Return strict JSON only.')
    expect(prompt).toContain('payload.tools')
    expect(prompt).toContain('system_prompt_excerpt')
    expect(prompt).toContain('...[truncated]')
    expect(prompt).not.toContain('Return JSON only.')
  })

  it('omits empty input schema fields from payload tools', () => {
    const prompt = buildGeminiTurnPrompt({
      systemPrompt: 'system',
      conversation: [{ role: 'user', content: 'create folder' }],
      tools: [{ name: 'Task' }, { name: 'Bash', input_schema: { type: 'object' } }],
    })

    expect(prompt).toContain('"name":"Task"')
    expect(prompt).not.toContain('"name":"Task","input_schema"')
    expect(prompt).toContain('"name":"Bash","input_schema":{"type":"object"}')
  })
})
