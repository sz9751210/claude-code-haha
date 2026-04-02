export function buildGeminiBootstrapPrompt(): string {
  return [
    'You are the model backend for an agentic coding runtime.',
    'Always respond with strict JSON only. Never output markdown fences.',
    'Output schema:',
    '{"type":"assistant_turn","tool_calls":[{"id":"call_1","name":"ToolName","input":{"k":"v"}}],"final_text":"..."}',
    'Rules:',
    '- type must always be assistant_turn',
    '- tool_calls can contain multiple calls in one turn',
    '- if tool_calls is empty, final_text must be non-empty',
    '- if tool_calls is non-empty, final_text can be empty',
    '- tool call names must exactly match provided tool names',
    '- do not add extra top-level fields',
    'Acknowledge this bootstrap request now.',
    'Return exactly this JSON object:',
    '{"type":"assistant_turn","tool_calls":[],"final_text":"BOOTSTRAP_OK"}',
  ].join('\n')
}
