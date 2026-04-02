export type GeminiProtocolTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
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

const GEMINI_MAX_SYSTEM_PROMPT_CHARS = 480
const GEMINI_MAX_MESSAGE_CHARS = 3_000

const GEMINI_TOOL_NAME_ALIASES = new Map<string, string>([
  ['bash', 'Bash'],
  ['shell', 'Bash'],
  ['terminal', 'Bash'],
  ['command', 'Bash'],
  ['execute_command', 'Bash'],
  ['run_terminal_command', 'Bash'],
  ['terminal_command', 'Bash'],
  ['run_shell_command', 'Bash'],
  ['run_command', 'Bash'],
  ['read_file', 'Read'],
  ['write_file', 'Write'],
  ['edit_file', 'Edit'],
  ['search_files', 'Glob'],
  ['glob', 'Glob'],
  ['grep', 'Grep'],
  ['ask_user', 'AskUserQuestion'],
  ['ask_user_question', 'AskUserQuestion'],
  ['spawn_agent', 'Task'],
  ['spawn_subagent', 'Task'],
  ['create_subagent', 'Task'],
  ['agent', 'Task'],
  ['task', 'Task'],
  ['task_create', 'Task'],
])

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

function resolveToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string {
  const trimmed = rawName.trim()
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed
  }

  if (allowedToolNames.has(trimmed)) {
    return trimmed
  }

  const lowerToAllowed = new Map<string, string>()
  for (const allowedName of allowedToolNames) {
    if (typeof allowedName !== 'string') {
      continue
    }
    const canonical = allowedName.trim()
    if (canonical.length === 0) {
      continue
    }
    lowerToAllowed.set(canonical.toLowerCase(), canonical)
  }

  const lower = trimmed.toLowerCase()
  const caseInsensitive = lowerToAllowed.get(lower)
  if (caseInsensitive) {
    return caseInsensitive
  }

  if (
    lower === 'task' ||
    lower === 'agent' ||
    lower === 'spawn_agent' ||
    lower === 'spawn_subagent' ||
    lower === 'create_subagent'
  ) {
    const agentName = lowerToAllowed.get('agent')
    if (agentName) {
      return agentName
    }
    const taskName = lowerToAllowed.get('task')
    if (taskName) {
      return taskName
    }
  }

  const alias = GEMINI_TOOL_NAME_ALIASES.get(lower)
  if (!alias) {
    return trimmed
  }

  return lowerToAllowed.get(alias.toLowerCase()) ?? trimmed
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

    const resolvedToolName = resolveToolName(call.name, options?.allowedToolNames)
    if (
      options?.allowedToolNames &&
      !options.allowedToolNames.has(resolvedToolName)
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
      name: resolvedToolName,
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
    'Return strict JSON only.',
    'Schema: {"type":"assistant_turn","tool_calls":[{"id":"call_1","name":"ToolName","input":{"k":"v"}}],"final_text":"..."}',
    'Rules: type=assistant_turn; support multiple tool calls; if tool_calls is empty final_text must be non-empty; if tool_calls is non-empty final_text may be empty; use tool names from payload.tools exactly.',
    `Payload:${JSON.stringify(payload)}`,
  ].join('\n')
}

export function buildGeminiProtocolRepairPrompt(args: {
  originalPrompt: string
  failureReason: string
  previousResponse: string
}): string {
  void args.originalPrompt
  return [
    'Your previous response violated the required JSON protocol.',
    `Failure reason: ${args.failureReason}`,
    'Regenerate the answer for the same request and payload context.',
    'Output strict JSON only, no markdown fences, no explanations.',
    'Previous invalid response (for debugging):',
    truncate(args.previousResponse, 800),
  ].join('\n')
}
