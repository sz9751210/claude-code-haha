# Gemini Web Provider Design (Playwright, Full Tool Loop)

Date: 2026-04-02  
Author: Codex + user brainstorming decisions

## 1. Summary

This design adds a new runtime provider, `geminiWeb`, to the existing Claude-Code-derived architecture.  
Unlike the current Anthropic-compatible API path, this provider drives `https://gemini.google.com/` through Playwright and still fully supports the existing tool loop (including multiple tool calls in one assistant turn).

The implementation is explicitly provider-switched (no automatic fallback), non-streaming (wait for full response before returning), and enforces two hard execution constraints:

1. Every new Gemini tab creation must be at least 5 seconds apart.
2. The system must wait for Gemini response completion before any next step.

Subagent isolation is mandatory: each spawned subagent gets its own Gemini tab to prevent context pollution, and every subagent startup always sends an initialization prompt.

## 2. Goals

- Add `geminiWeb` as a first-class provider in existing provider selection flow.
- Keep existing query/tool orchestration semantics intact.
- Support complete tool loop behavior:
  - tool use emission from model output
  - tool execution by existing runtime
  - tool result reinjection to model
  - repeated cycles until final answer
- Support multiple tool calls in one model turn.
- Use robust structured-output protocol (JSON-only) with retry-on-parse-failure.
- Reuse a local logged-in browser profile/cookies after one-time manual Google login.

## 3. Non-Goals (Phase 1)

- No token-by-token streaming from Gemini UI.
- No dual-backend implementation (agent-browser + Playwright) in first release.
- No automatic Anthropic->Gemini fallback.
- No support for additional Gemini entry points (AI Studio, etc.) in phase 1.

## 4. User-Confirmed Constraints

- Provider activation is explicit (env/config), not implicit fallback.
- Target endpoint is fixed to `https://gemini.google.com/`.
- Backend is Playwright first.
- Structured output is mandatory; parse/validation failures auto-retry.
- A single model turn may contain multiple tool calls.
- New Gemini tab creation must honor a global minimum interval of 5 seconds.
- Next action must wait until current Gemini response is fully complete.
- Subagents must execute in separate tabs and always receive init prompt.

## 5. High-Level Architecture

The design preserves current control flow:

`query.ts -> deps.callModel(...) -> assistant/tool_use blocks -> existing tool runtime -> tool_result -> callModel(...)`

Only the model-call implementation changes under `geminiWeb`.

### 5.1 Provider layer

Add `geminiWeb` to provider enum and resolver:

- File: `src/utils/model/providers.ts`
- New explicit toggle (example): `CLAUDE_CODE_USE_GEMINI_WEB=true`
- Priority rule: if Gemini-Web flag enabled, provider resolves to `geminiWeb`

### 5.2 Query dependency routing

- File: `src/query/deps.ts`
- Replace static single binding (`queryModelWithStreaming`) with provider-aware `callModel` resolver:
  - non-`geminiWeb`: existing `queryModelWithStreaming`
  - `geminiWeb`: new `queryModelWithGeminiWebNonStreaming`

This keeps `query.ts` tool loop stable and minimizes risk.

### 5.3 New module family

Create `src/services/geminiWeb/`:

- `queryModelWithGeminiWebNonStreaming.ts`
  - Interface-compatible `callModel` implementation.
- `GeminiBrowserPool.ts`
  - Playwright browser/context lifecycle and page registry.
- `GeminiProtocol.ts`
  - JSON schema validation, semantic validation, retry repair prompts.
- `GeminiTabRateLimiter.ts`
  - Enforces 5-second minimum interval before each `newPage()`.
- `GeminiResponseWaiter.ts`
  - Detects completion state; blocks until response is done.
- `GeminiSessionRouter.ts`
  - Maps `main` and `agent:<agentId>` to dedicated tabs.
- `GeminiBootstrapPrompt.ts`
  - Constructs mandatory initialization prompt text.

## 6. Session and Tab Isolation Model

Session key strategy:

- Main thread: `main`
- Subagent: `agent:<agentId>`

Behavior:

- Each key binds to one dedicated tab.
- If key is missing, create new tab (through global 5-second limiter).
- Subagents never share tabs with each other or main thread.
- On first key initialization, send bootstrap prompt before any task prompt.

This enforces context isolation and satisfies mandatory init-prompt behavior.

## 7. Structured Output Protocol

Gemini must answer in strict JSON only.

Example envelope:

```json
{
  "type": "assistant_turn",
  "tool_calls": [
    {
      "id": "call_1",
      "name": "Bash",
      "input": { "cmd": "ls -la" }
    }
  ],
  "final_text": ""
}
```

Rules:

- `tool_calls` may contain multiple entries.
- If `tool_calls.length > 0`, `final_text` may be empty.
- If no tool call exists, `final_text` must be non-empty.
- Unknown tool names, malformed inputs, or schema mismatch are protocol errors.

Retry policy:

- Max 3 protocol repair attempts per turn.
- Repair prompt includes parse/validation failure reason and requests JSON-only output.
- Exhaustion produces a typed system API error message for existing error path handling.

## 8. End-to-End Turn Flow (Gemini Provider)

1. Build model input from current conversation state and tool results.
2. Resolve session key (`main` or `agent:<agentId>`).
3. Ensure page exists:
   - if creating new page, enforce `GeminiTabRateLimiter.acquire()`.
4. If first-use for key, send bootstrap/init prompt.
5. Send current prompt payload to Gemini UI.
6. Wait in `GeminiResponseWaiter` until completion criteria satisfied.
7. Extract raw response text.
8. Parse/validate JSON protocol (with retry loop if needed).
9. Convert protocol to existing runtime message shape:
   - tool calls -> `tool_use` blocks
   - final text -> assistant text block
10. Return to existing query loop for tool execution or termination.

Non-streaming means output is emitted only after step 9.

## 9. Response Completion Contract

`GeminiResponseWaiter` returns only when all are true:

- Generation appears complete in page state (UI controls/status).
- Response DOM/text stabilizes for a quiet window.
- No terminal error state is detected (signin/rate-limit/block/page error).

If completion cannot be confirmed within timeout:

- classify as provider error
- optionally recreate tab once (still respecting 5-second tab creation rule)
- then fail with typed error if still unresolved

## 10. Authentication and Profile Strategy

Phase-1 auth model:

- User performs first manual login once in browser profile.
- Runtime reuses local persistent Playwright profile/cookies.
- If not logged in, provider emits actionable signin-required error.

No credential scraping or token extraction is performed.

## 11. Error Handling Matrix

- Protocol parse failure -> retry repair (up to 3) -> protocol error.
- Tool schema mismatch -> retry repair (up to 3) -> protocol error.
- Page crash/detach -> recreate page (rate-limited) -> retry once.
- Gemini blocked/rate limited -> provider error with diagnostic message.
- Auth required -> explicit signin-required error.

All errors flow through existing query error conventions when possible.

## 12. Testing Plan

### 12.1 Unit tests

- `GeminiProtocol` parse/validate/repair behavior.
- `GeminiTabRateLimiter` enforces `>= 5000ms` gap.
- `GeminiSessionRouter` key->tab isolation logic.
- `GeminiResponseWaiter` completion detection and timeout behavior.

### 12.2 Integration tests

- `query.ts` tool loop unchanged with Gemini provider route.
- Multiple tool calls in one turn map correctly and execute in order.
- Tool-result reinjection works across multiple rounds.
- Subagent startup always initializes isolated tab + init prompt.

### 12.3 Canary E2E (real browser)

- Logged-in profile opens `gemini.google.com`.
- Main thread simple response works.
- Multi-tool-call round trip works.
- Two subagents run on separate tabs without context leakage.
- Recorded tab creation timestamps always satisfy 5-second minimum.

## 13. Rollout and Config

Phase-1 runtime switches:

- `CLAUDE_CODE_USE_GEMINI_WEB=true`

Phase-1 constants (not configurable in this release):

- Gemini URL is fixed to `https://gemini.google.com/`
- New-tab interval is fixed to exactly 5000 ms minimum
- Protocol repair retries are fixed to 3 attempts

Default behavior remains unchanged unless explicit Gemini flag is enabled.

## 14. Scope Check and Decomposition

This spec is intentionally scoped to one implementation plan:

- Add one provider path
- Keep existing orchestration core
- Deliver full tool loop parity through structured protocol
- Enforce tab isolation and execution pacing constraints

No secondary subsystem (dual backend, streaming, alternative Gemini endpoints) is required for this phase.
