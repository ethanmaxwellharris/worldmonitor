import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GROQ_MODEL, getGroqModel, groqChatParams } from '../api/_groq.js';

test('default Groq model is openai/gpt-oss-20b', () => {
  const prev = process.env.GROQ_MODEL;
  delete process.env.GROQ_MODEL;
  assert.equal(getGroqModel(), 'openai/gpt-oss-20b');
  assert.equal(DEFAULT_GROQ_MODEL, 'openai/gpt-oss-20b');
  if (prev !== undefined) process.env.GROQ_MODEL = prev;
});

test('GROQ_MODEL env overrides the default', () => {
  const prev = process.env.GROQ_MODEL;
  process.env.GROQ_MODEL = '  openai/gpt-oss-120b ';
  assert.equal(getGroqModel(), 'openai/gpt-oss-120b');
  if (prev === undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL = prev;
});

test('gpt-oss params hide reasoning and reserve reasoning headroom', () => {
  const p = groqChatParams('openai/gpt-oss-20b', 50);
  assert.equal(p.include_reasoning, false);
  assert.equal(p.reasoning_effort, 'low');
  assert.ok(p.max_completion_tokens > 50);
  assert.equal(p.max_tokens, undefined);
});

test('non-reasoning models keep plain max_tokens', () => {
  assert.deepEqual(groqChatParams('llama-3.3-70b-versatile', 150), { max_tokens: 150 });
});
