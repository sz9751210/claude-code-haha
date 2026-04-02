import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Options } from '../api/claude.js'
import type { Tool } from '../../Tool.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
} from '../../utils/messages.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { buildGeminiBootstrapPrompt } from './GeminiBootstrapPrompt.js'
import { getGeminiBrowserPool } from './GeminiBrowserPool.js'
import {
  commitGeminiConversationSnapshot,
  planGeminiConversationDelta,
} from './GeminiConversationDelta.js'
import { GEMINI_PROTOCOL_MAX_REPAIR_ATTEMPTS } from './GeminiConstants.js'
import {
  buildGeminiProtocolRepairPrompt,
  buildGeminiTurnPrompt,
  parseGeminiAssistantTurn,
  type GeminiConversationMessage,
  type GeminiProtocolTool,
} from './GeminiProtocol.js'
import { getGeminiSessionKey } from './GeminiSessionRouter.js'

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function formatContentBlocks(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(block => {
      if (!block || typeof block !== 'object') {
        return ''
      }

      const typedBlock = block as { type?: string; [k: string]: unknown }
      if (typedBlock.type === 'text') {
        return typeof typedBlock.text === 'string' ? typedBlock.text : ''
      }
      if (typedBlock.type === 'tool_use') {
        return `[tool_use] name=${String(
          typedBlock.name ?? '',
        )} id=${String(typedBlock.id ?? '')} input=${safeStringify(
          typedBlock.input,
        )}`
      }
      if (typedBlock.type === 'tool_result') {
        return `[tool_result] tool_use_id=${String(
          typedBlock.tool_use_id ?? '',
        )} content=${safeStringify(typedBlock.content)}`
      }

      return `[${String(typedBlock.type ?? 'unknown')}]`
    })
    .filter(line => line.length > 0)
    .join('\n')
}

function formatConversation(messages: Message[]): GeminiConversationMessage[] {
  const result: GeminiConversationMessage[] = []

  for (const message of messages) {
    if (!('message' in message)) {
      continue
    }

    const role =
      message.type === 'assistant'
        ? 'assistant'
        : message.type === 'system'
          ? 'system'
          : 'user'

    const content = formatContentBlocks(
      (message as { message?: { content?: unknown } }).message?.content,
    )
    if (!content || content.trim().length === 0) {
      continue
    }

    result.push({
      role,
      content,
    })
  }

  return result
}

function compactJsonSchema(
  schema: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    depth > 4
  ) {
    return undefined
  }

  const source = schema as Record<string, unknown>
  const compact: Record<string, unknown> = {}

  if (typeof source.type === 'string') {
    compact.type = source.type
  }
  if (Array.isArray(source.enum)) {
    compact.enum = source.enum
  }
  if (Array.isArray(source.required)) {
    compact.required = source.required
  }
  if (typeof source.additionalProperties === 'boolean') {
    compact.additionalProperties = source.additionalProperties
  }

  if (source.properties && typeof source.properties === 'object') {
    const entries = Object.entries(source.properties as Record<string, unknown>)
    const compactProps = Object.fromEntries(
      entries
        .map(([key, value]) => [key, compactJsonSchema(value, depth + 1) ?? {}])
        .filter((entry): entry is [string, Record<string, unknown>] =>
          Boolean(entry[1]),
        ),
    )
    if (Object.keys(compactProps).length > 0) {
      compact.properties = compactProps
    }
  }

  if (source.items) {
    const compactItems = compactJsonSchema(source.items, depth + 1)
    if (compactItems) {
      compact.items = compactItems
    }
  }

  return Object.keys(compact).length > 0 ? compact : undefined
}

function buildToolInputSchema(tool: Tool): Record<string, unknown> | undefined {
  const rawSchema =
    'inputJSONSchema' in tool && tool.inputJSONSchema
      ? tool.inputJSONSchema
      : zodToJsonSchema(tool.inputSchema)

  const compact = compactJsonSchema(rawSchema)
  const props =
    compact &&
    compact.type === 'object' &&
    compact.properties &&
    typeof compact.properties === 'object'
      ? (compact.properties as Record<string, unknown>)
      : undefined

  // For no-arg tools, keep schema empty so prompt payload stays compact.
  if (!props || Object.keys(props).length === 0) {
    return undefined
  }

  return compact
}

function formatTools(tools: Tools): GeminiProtocolTool[] {
  return tools
    .map(tool => {
      const inputSchema = buildToolInputSchema(tool)
      return {
        name: tool.name,
        ...(inputSchema ? { input_schema: inputSchema } : {}),
      }
    })
    .filter(tool => typeof tool.name === 'string' && tool.name.trim().length > 0)
}

function turnToContentBlocks(raw: {
  tool_calls: Array<{ id: string; name: string; input: Record<string, unknown> }>
  final_text: string
}): BetaContentBlock[] {
  const content: BetaContentBlock[] = []

  for (const toolCall of raw.tool_calls) {
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
    } as BetaContentBlock)
  }

  if (raw.final_text.trim().length > 0) {
    content.push({
      type: 'text',
      text: raw.final_text,
    } as BetaContentBlock)
  }

  return content.length > 0
    ? content
    : ([
        {
          type: 'text',
          text: '[Gemini Web returned empty content]',
        } as BetaContentBlock,
      ] as BetaContentBlock[])
}

function buildInitialPrompt(args: {
  systemPrompt: SystemPrompt
  conversation: GeminiConversationMessage[]
  protocolTools: GeminiProtocolTool[]
}): string {
  return buildGeminiTurnPrompt({
    systemPrompt: args.systemPrompt.join('\n\n'),
    conversation: args.conversation,
    tools: args.protocolTools,
  })
}

export async function* queryModelWithGeminiWebNonStreaming({
  messages,
  systemPrompt,
  thinkingConfig: _thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  const browserPool = getGeminiBrowserPool()
  const sessionKey = getGeminiSessionKey(options.agentId)
  const bootstrapPrompt = buildGeminiBootstrapPrompt()
  const protocolTools = formatTools(tools)
  const allowedToolNames = new Set(protocolTools.map(tool => tool.name))
  try {
    const fullConversation = formatConversation(messages)
    const forceFullSync = !(await browserPool.isSessionInitialized(sessionKey))
    const deltaPlan = planGeminiConversationDelta({
      sessionKey,
      conversation: fullConversation,
      forceFullSync,
    })
    const conversationForPrompt =
      deltaPlan.deltaConversation.length > 0
        ? deltaPlan.deltaConversation
        : fullConversation.slice(-1)
    const initialPrompt = buildInitialPrompt({
      systemPrompt,
      conversation: conversationForPrompt,
      protocolTools,
    })

    let promptToSend = initialPrompt
    let didCommitConversation = false
    for (let repairAttempt = 0; ; repairAttempt++) {
      const rawResponse = await browserPool.sendPromptAndWait({
        sessionKey,
        prompt: promptToSend,
        signal,
        bootstrapPrompt,
      })
      if (!didCommitConversation) {
        commitGeminiConversationSnapshot(sessionKey, deltaPlan.snapshot)
        didCommitConversation = true
      }

      const parsed = parseGeminiAssistantTurn(rawResponse, {
        allowedToolNames,
      })
      if (parsed.ok) {
        yield createAssistantMessage({
          content: turnToContentBlocks(parsed.value),
        })
        return
      }

      if (repairAttempt >= GEMINI_PROTOCOL_MAX_REPAIR_ATTEMPTS) {
        yield createAssistantAPIErrorMessage({
          content: `Gemini Web protocol parsing failed after ${GEMINI_PROTOCOL_MAX_REPAIR_ATTEMPTS} retries: ${parsed.error}`,
        })
        return
      }

      promptToSend = buildGeminiProtocolRepairPrompt({
        originalPrompt: initialPrompt,
        failureReason: parsed.error,
        previousResponse: rawResponse,
      })
    }
  } catch (error) {
    if (signal.aborted) {
      return
    }

    yield createAssistantAPIErrorMessage({
      content: `Gemini Web provider error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }
}
