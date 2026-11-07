/**
 * Shared Groq model configuration.
 *
 * Groq retired `llama-3.1-8b-instant` from the free/developer plans, so the
 * default is now `openai/gpt-oss-20b`. Override with the server-side
 * `GROQ_MODEL` env var (e.g. `openai/gpt-oss-120b`).
 *
 * gpt-oss models are reasoning models: reasoning tokens count against
 * max_completion_tokens and are returned in `message.reasoning` unless
 * `include_reasoning: false` is sent. groqChatParams() handles both so the
 * existing `message.content` parsing keeps working.
 */

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export function getGroqModel() {
  const fromEnv = typeof process !== 'undefined' ? process.env?.GROQ_MODEL : undefined;
  const trimmed = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  return trimmed || DEFAULT_GROQ_MODEL;
}

export function isGptOssModel(model) {
  return typeof model === 'string' && model.startsWith('openai/gpt-oss');
}

// Headroom added for hidden reasoning tokens on reasoning models.
const REASONING_HEADROOM_TOKENS = 512;

/**
 * Model-specific request body fields.
 * @param {string} model
 * @param {number} maxTokens - budget for the visible answer
 * @returns {Record<string, unknown>}
 */
export function groqChatParams(model, maxTokens) {
  if (isGptOssModel(model)) {
    return {
      max_completion_tokens: maxTokens + REASONING_HEADROOM_TOKENS,
      reasoning_effort: 'low',
      include_reasoning: false,
    };
  }
  return { max_tokens: maxTokens };
}
