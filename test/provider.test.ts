import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateCostUsd,
  keyEnvVar,
  projectCostUsd,
  providerFrom,
  AiClient,
  ollamaBaseUrl,
  ollamaContextTokens,
} from '../src/lib/ai/client.ts';

const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

test('a self-hosted model costs nothing, and so does Gemini', () => {
  for (const model of ['qwen2.5:7b', 'llama3.2:3b', 'gemma3:12b', 'gemini-3.6-flash']) {
    assert.equal(estimateCostUsd(model, usage), 0, `${model} should be free`);
    assert.equal(projectCostUsd(model, 400_000, 32_000), 0, `${model} should project free`);
  }
});

test('an UNKNOWN Claude model is still priced, not treated as free', () => {
  // The guard that makes local models free is "not a Claude model". If it were
  // "not in the price table", a model name this app has not learned yet -- a new
  // Claude release, or a typo in AI_MODEL -- would be billed at $0 and the spend
  // caps would quietly stop applying to it. It falls back to Opus rates instead,
  // which errs in the safe direction for a cap.
  const unknown = estimateCostUsd('claude-opus-9', usage);
  assert.equal(unknown, estimateCostUsd('claude-opus-5', usage));
  assert.ok(unknown > 0, 'an unrecognised Claude model must not be free');
  assert.ok(projectCostUsd('claude-opus-9', 400_000, 32_000) > 0);
});

test('a known Claude model keeps its own rate', () => {
  assert.ok(estimateCostUsd('claude-haiku-4-5', usage) < estimateCostUsd('claude-sonnet-5', usage));
  assert.ok(estimateCostUsd('claude-sonnet-5', usage) < estimateCostUsd('claude-opus-5', usage));
});

test('the stored provider string is narrowed, and anything unrecognised falls back to Claude', () => {
  assert.equal(providerFrom('ollama'), 'ollama');
  assert.equal(providerFrom('gemini'), 'gemini');
  assert.equal(providerFrom('claude'), 'claude');
  // A NULL column, an empty string or a typo must not route to a server nobody
  // started; failing loudly on a missing key is the better failure.
  assert.equal(providerFrom(null), 'claude');
  assert.equal(providerFrom(undefined), 'claude');
  assert.equal(providerFrom('Ollama'), 'claude');
  assert.equal(providerFrom(''), 'claude');
});

test('Ollama needs no key, so it is always configured', () => {
  const key = process.env.ANTHROPIC_API_KEY;
  const gem = process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(AiClient.isConfigured('ollama'), true);
    assert.equal(AiClient.isConfigured('claude'), false);
    assert.equal(AiClient.isConfigured('gemini'), false);
  } finally {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
    if (gem !== undefined) process.env.GEMINI_API_KEY = gem;
  }
  assert.equal(keyEnvVar('ollama'), 'OLLAMA_BASE_URL');
});

test('a trailing slash on OLLAMA_BASE_URL does not produce a double slash', () => {
  // `${base}/api/chat` against "http://host:11434/" would request //api/chat,
  // which Ollama 404s -- and a 404 there is reported as "model not pulled".
  const before = process.env.OLLAMA_BASE_URL;
  try {
    process.env.OLLAMA_BASE_URL = 'http://192.168.1.50:11434/';
    assert.equal(ollamaBaseUrl(), 'http://192.168.1.50:11434');
    process.env.OLLAMA_BASE_URL = 'http://192.168.1.50:11434///';
    assert.equal(ollamaBaseUrl(), 'http://192.168.1.50:11434');
    delete process.env.OLLAMA_BASE_URL;
    assert.equal(ollamaBaseUrl(), 'http://127.0.0.1:11434');
  } finally {
    if (before === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = before;
  }
});

test('the context window is never left at Ollama’s silent 4096 default', () => {
  const before = process.env.OLLAMA_NUM_CTX;
  try {
    delete process.env.OLLAMA_NUM_CTX;
    assert.ok(ollamaContextTokens() >= 16384, 'a profile plus a full posting does not fit in 4096');
    process.env.OLLAMA_NUM_CTX = '8192';
    assert.equal(ollamaContextTokens(), 8192);
    // A non-numeric value must not become NaN and get sent as num_ctx.
    process.env.OLLAMA_NUM_CTX = 'lots';
    assert.ok(Number.isFinite(ollamaContextTokens()));
  } finally {
    if (before === undefined) delete process.env.OLLAMA_NUM_CTX;
    else process.env.OLLAMA_NUM_CTX = before;
  }
});
