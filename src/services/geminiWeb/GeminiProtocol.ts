export type GeminiProtocolTool = {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type GeminiConversationMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type GeminiToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type GeminiAssistantTurn = {
  type: 'assistant_turn'
  tool_calls: GeminiToolCall[]
  final_text: string
}

export type GeminiProtocolParseResult =
  | { ok: true; value: GeminiAssistantTurn }
  | { ok: false; error: string }

const GEMINI_MAX_SYSTEM_PROMPT_CHARS = 1_200
const GEMINI_MAX_MESSAGE_CHARS = 6_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(text: string, max = 2_000): string {
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max)}\n...[truncated]`
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function compactText(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text)
  if (normalized.length <= maxChars) {
    return normalized
  }
  return `${normalized.slice(0, maxChars)}...[truncated]`
}

function extractJsonCandidate(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
  }

  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1).trim()
  }

  return trimmed
}

export function parseGeminiAssistantTurn(
  rawResponse: string,
  options?: { allowedToolNames?: Set<string> },
): GeminiProtocolParseResult {
  const candidate = extractJsonCandidate(rawResponse)

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (error) {
    return {
      ok: false,
      error: `JSON parse failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: 'Protocol object must be a JSON object',
    }
  }

  if (parsed.type !== 'assistant_turn') {
    return {
      ok: false,
      error: 'Field "type" must equal "assistant_turn"',
    }
  }

  if (!Array.isArray(parsed.tool_calls)) {
    return {
      ok: false,
      error: 'Field "tool_calls" must be an array',
    }
  }

  if (typeof parsed.final_text !== 'string') {
    return {
      ok: false,
      error: 'Field "final_text" must be a string',
    }
  }

  const seenIds = new Set<string>()
  const toolCalls: GeminiToolCall[] = []
  for (const [index, call] of parsed.tool_calls.entries()) {
    if (!isRecord(call)) {
      return {
        ok: false,
        error: `tool_calls[${index}] must be an object`,
      }
    }

    if (typeof call.id !== 'string' || call.id.trim() === '') {
      return {
        ok: false,
        error: `tool_calls[${index}].id must be a non-empty string`,
      }
    }

    if (seenIds.has(call.id)) {
      return {
        ok: false,
        error: `tool_calls[${index}].id must be unique`,
      }
    }
    seenIds.add(call.id)

    if (typeof call.name !== 'string' || call.name.trim() === '') {
      return {
        ok: false,
        error: `tool_calls[${index}].name must be a non-empty string`,
      }
    }

    if (
      options?.allowedToolNames &&
      !options.allowedToolNames.has(call.name.trim())
    ) {
      return {
        ok: false,
        error: `tool_calls[${index}].name "${call.name}" is not an allowed tool`,
      }
    }

    if (!isRecord(call.input)) {
      return {
        ok: false,
        error: `tool_calls[${index}].input must be an object`,
      }
    }

    toolCalls.push({
      id: call.id.trim(),
      name: call.name.trim(),
      input: call.input,
    })
  }

  const finalText = parsed.final_text
  if (toolCalls.length === 0 && finalText.trim() === '') {
    return {
      ok: false,
      error: 'When tool_calls is empty, final_text must be non-empty',
    }
  }

  return {
    ok: true,
    value: {
      type: 'assistant_turn',
      tool_calls: toolCalls,
      final_text: finalText,
    },
  }
}

export function buildGeminiTurnPrompt(args: {
  systemPrompt: string
  conversation: GeminiConversationMessage[]
  tools: GeminiProtocolTool[]
}): string {
  const compactConversation = args.conversation.map(message => ({
    role: message.role,
    content: compactText(message.content, GEMINI_MAX_MESSAGE_CHARS),
  }))

  const compactSystemPrompt = compactText(
    args.systemPrompt,
    GEMINI_MAX_SYSTEM_PROMPT_CHARS,
  )

  const payload = {
    protocol: 'gemini_web_tool_loop_v1',
    system_prompt_excerpt: compactSystemPrompt,
    conversation: compactConversation,
    tools: args.tools,
  }

  return [
    'Return JSON only.',
    'Schema: {"type":"assistant_turn","tool_calls":[{"id":"call_1","name":"ToolName","input":{"k":"v"}}],"final_text":"..."}',
    'Rules: type=assistant_turn; support multiple tool calls; if tool_calls is empty final_text must be non-empty; if tool_calls is non-empty final_text may be empty; tool names must match exactly.',
    `Payload: ${JSON.stringify(payload)}`,
  ].join('\n\n')
}

export function buildGeminiProtocolRepairPrompt(args: {
  originalPrompt: string
  failureReason: string
  previousResponse: string
}): string {
  return [
    'Your previous response violated the required JSON protocol.',
    `Failure reason: ${args.failureReason}`,
    'Regenerate the answer for the same request.',
    'Output strict JSON only, no markdown fences, no explanations.',
    'Original request:',
    args.originalPrompt,
    'Previous invalid response (for debugging):',
    truncate(args.previousResponse),
  ].join('\n\n')
}
