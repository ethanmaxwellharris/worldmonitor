/**
 * Groq API Summarization Endpoint with Redis Caching
 * Model: GROQ_MODEL env override, default openai/gpt-oss-20b (see _groq.js)
 * Server-side Redis cache for cross-user deduplication
 */

import { createSummarizeHandler } from './_summarize-handler.js';
import { GROQ_API_URL, getGroqModel, groqChatParams } from './_groq.js';

export const config = {
  runtime: 'edge',
};

export default createSummarizeHandler({
  name: 'groq',
  logTag: '[Groq]',
  skipReason: 'GROQ_API_KEY not configured',
  getCredentials() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    const model = getGroqModel();
    // max_tokens: undefined drops the shared handler's max_tokens when the
    // model uses max_completion_tokens instead (JSON.stringify skips undefined).
    const extraBody = { max_tokens: undefined, ...groqChatParams(model, 150) };
    return {
      apiUrl: GROQ_API_URL,
      model,
      extraBody,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
  },
});
