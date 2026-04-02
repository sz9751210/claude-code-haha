import { getGeminiBrowserPool } from './GeminiBrowserPool.js'

async function run(): Promise<void> {
  const pool = getGeminiBrowserPool()
  try {
    const prompt =
      'Reply with strict JSON only: {"type":"assistant_turn","tool_calls":[],"final_text":"SMOKE_OK"}'
    const text = await pool.sendPromptAndWait({
      sessionKey: 'main',
      prompt,
      timeoutMs: 120_000,
    })

    console.log(
      JSON.stringify(
        {
          ok: true,
          length: text.length,
          preview: text.slice(0, 800),
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  } finally {
    await pool.close()
  }
}

run()
