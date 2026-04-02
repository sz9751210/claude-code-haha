export type GeminiSessionKey = 'main' | `agent:${string}`

export function getGeminiSessionKey(agentId?: string): GeminiSessionKey {
  return agentId ? `agent:${agentId}` : 'main'
}

export type GeminiSession<TPage> = {
  key: GeminiSessionKey
  page: TPage
  initialized: boolean
}

export class GeminiSessionRouter<TPage> {
  private readonly sessions = new Map<GeminiSessionKey, GeminiSession<TPage>>()
  private readonly pendingCreations = new Map<
    GeminiSessionKey,
    Promise<GeminiSession<TPage>>
  >()

  async getOrCreate(
    key: GeminiSessionKey,
    createPage: () => Promise<TPage>,
  ): Promise<GeminiSession<TPage>> {
    const existing = this.sessions.get(key)
    if (existing) {
      return existing
    }

    const pending = this.pendingCreations.get(key)
    if (pending) {
      return pending
    }

    const creation = (async () => {
      const page = await createPage()
      const created: GeminiSession<TPage> = {
        key,
        page,
        initialized: false,
      }
      this.sessions.set(key, created)
      return created
    })()

    this.pendingCreations.set(key, creation)
    try {
      return await creation
    } finally {
      this.pendingCreations.delete(key)
    }
  }

  markInitialized(key: GeminiSessionKey): void {
    const session = this.sessions.get(key)
    if (!session) {
      return
    }
    session.initialized = true
  }

  remove(key: GeminiSessionKey): void {
    this.sessions.delete(key)
  }
}
