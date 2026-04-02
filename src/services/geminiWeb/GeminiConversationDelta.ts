import type { GeminiConversationMessage } from './GeminiProtocol.js'
import type { GeminiSessionKey } from './GeminiSessionRouter.js'

type GeminiConversationSnapshot = string[]

const sessionSnapshots = new Map<GeminiSessionKey, GeminiConversationSnapshot>()

function serializeConversation(
  conversation: GeminiConversationMessage[],
): GeminiConversationSnapshot {
  return conversation.map(message => `${message.role}\n${message.content}`)
}

function commonPrefixLength(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a[index] === b[index]) {
    index += 1
  }
  return index
}

export function planGeminiConversationDelta(args: {
  sessionKey: GeminiSessionKey
  conversation: GeminiConversationMessage[]
  forceFullSync?: boolean
}): {
  deltaConversation: GeminiConversationMessage[]
  snapshot: GeminiConversationSnapshot
} {
  const snapshot = serializeConversation(args.conversation)
  const previousSnapshot = sessionSnapshots.get(args.sessionKey)

  if (args.forceFullSync || !previousSnapshot) {
    return {
      deltaConversation: args.conversation,
      snapshot,
    }
  }

  const prefix = commonPrefixLength(previousSnapshot, snapshot)
  return {
    deltaConversation: args.conversation.slice(prefix),
    snapshot,
  }
}

export function commitGeminiConversationSnapshot(
  sessionKey: GeminiSessionKey,
  snapshot: GeminiConversationSnapshot,
): void {
  sessionSnapshots.set(sessionKey, [...snapshot])
}

export function resetGeminiConversationSnapshots(
  sessionKey?: GeminiSessionKey,
): void {
  if (sessionKey) {
    sessionSnapshots.delete(sessionKey)
    return
  }
  sessionSnapshots.clear()
}
