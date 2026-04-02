import { beforeEach, describe, expect, it } from 'bun:test'
import {
  commitGeminiConversationSnapshot,
  planGeminiConversationDelta,
  resetGeminiConversationSnapshots,
} from './GeminiConversationDelta.js'

describe('GeminiConversationDelta', () => {
  beforeEach(() => {
    resetGeminiConversationSnapshots()
  })

  it('returns full conversation on first sync', () => {
    const conversation = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ]

    const plan = planGeminiConversationDelta({
      sessionKey: 'main',
      conversation,
    })

    expect(plan.deltaConversation).toEqual(conversation)
  })

  it('returns only appended messages after snapshot commit', () => {
    const initial = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ]
    const next = [
      ...initial,
      { role: 'user' as const, content: 'run tests' },
      { role: 'assistant' as const, content: '[tool_use] name=Bash id=call_1' },
    ]

    const firstPlan = planGeminiConversationDelta({
      sessionKey: 'main',
      conversation: initial,
    })
    commitGeminiConversationSnapshot('main', firstPlan.snapshot)

    const secondPlan = planGeminiConversationDelta({
      sessionKey: 'main',
      conversation: next,
    })

    expect(secondPlan.deltaConversation).toEqual(next.slice(initial.length))
  })

  it('forces full sync when requested', () => {
    const oldConversation = [{ role: 'user' as const, content: 'old' }]
    const newConversation = [{ role: 'user' as const, content: 'new' }]

    const firstPlan = planGeminiConversationDelta({
      sessionKey: 'main',
      conversation: oldConversation,
    })
    commitGeminiConversationSnapshot('main', firstPlan.snapshot)

    const forcedPlan = planGeminiConversationDelta({
      sessionKey: 'main',
      conversation: newConversation,
      forceFullSync: true,
    })

    expect(forcedPlan.deltaConversation).toEqual(newConversation)
  })

  it('returns empty delta when conversation is unchanged', () => {
    const conversation = [{ role: 'user' as const, content: 'same' }]

    const firstPlan = planGeminiConversationDelta({
      sessionKey: 'main',
      conversation,
    })
    commitGeminiConversationSnapshot('main', firstPlan.snapshot)

    const secondPlan = planGeminiConversationDelta({
      sessionKey: 'main',
      conversation,
    })

    expect(secondPlan.deltaConversation).toEqual([])
  })
})
