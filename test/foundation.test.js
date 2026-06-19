import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  TTLCache,
  assertFreeModel,
  assertIqWikiUrl,
  createRateLimiter,
  extractModelContent,
  extractWikiText,
  getFreeModelCandidates,
  parseStrictJson
} from '../lib/foundation.js';
import { callOpenRouter, validateGeneratedResult } from '../api/generate.js';

test('accepts direct HTTPS IQ.wiki article URLs', () => {
  assert.equal(
    assertIqWikiUrl('https://iq.wiki/wiki/solana?utm_source=test#history'),
    'https://iq.wiki/wiki/solana'
  );
});

test('rejects non-IQ.wiki and non-article URLs', () => {
  assert.throws(() => assertIqWikiUrl('https://example.com/wiki/solana'), AppError);
  assert.throws(() => assertIqWikiUrl('https://iq.wiki/rank/cryptocurrencies'), AppError);
});

test('blocks paid OpenRouter models', () => {
  assert.equal(assertFreeModel('openrouter/free'), 'openrouter/free');
  assert.equal(assertFreeModel('meta-llama/model:free'), 'meta-llama/model:free');
  assert.throws(() => assertFreeModel('google/gemini-pro'), /not free/);
});

test('builds a deduplicated free-only model list', () => {
  assert.deepEqual(
    getFreeModelCandidates('openrouter/free, openai/gpt-oss-20b:free', ['openrouter/free']),
    ['openrouter/free', 'openai/gpt-oss-20b:free']
  );
  assert.throws(
    () => getFreeModelCandidates('openrouter/free,google/gemini-pro'),
    /not free/
  );
});

test('fails over between free models without adding a paid model', async () => {
  const calls = [];
  const generated = await callOpenRouter('prompt', 'example.com', [
    'openrouter/free',
    'openai/gpt-oss-20b:free'
  ], async (_prompt, _host, model) => {
    calls.push(model);
    if (model === 'openrouter/free') {
      throw new AppError(429, 'FREE_MODEL_QUOTA', 'capacity', true);
    }
    return { voiceover: 'working' };
  });
  assert.deepEqual(calls, ['openrouter/free', 'openai/gpt-oss-20b:free']);
  assert.deepEqual(generated, {
    result: { voiceover: 'working' },
    model: 'openai/gpt-oss-20b:free'
  });
});

test('cache expires and rate limiter blocks excess requests', async () => {
  const cache = new TTLCache();
  cache.set('key', 'value', 5);
  assert.equal(cache.get('key'), 'value');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cache.get('key'), undefined);
  const limit = createRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limit('client').allowed, true);
  assert.equal(limit('client').allowed, false);
});

test('updating a full cache does not evict another entry', () => {
  const cache = new TTLCache(2);
  cache.set('first', 1, 1000);
  cache.set('second', 2, 1000);
  cache.set('first', 3, 1000);
  assert.equal(cache.get('first'), 3);
  assert.equal(cache.get('second'), 2);
});

test('validates complete grounded video plans', () => {
  const plan = validateGeneratedResult('video_scenario', {
    hooks: ['Hook'],
    voiceover: 'Narration',
    scenes: [{
      time: '0-3s',
      visual: 'Show the protocol interface',
      caption: 'Protocol launch',
      voiceover: 'Scene narration',
      source_fact: 'The article says the protocol launched.'
    }],
    cta: 'Read more'
  });
  assert.equal(plan.scenes[0].visual, 'Show the protocol interface');
  assert.throws(
    () => validateGeneratedResult('video_scenario', {
      hooks: 'Hook',
      voiceover: 'Narration',
      scenes: []
    }),
    /incomplete answer/
  );
});

test('fails over when a free model returns the wrong result shape', async () => {
  const calls = [];
  const generated = await callOpenRouter(
    'prompt',
    'example.com',
    ['openrouter/free', 'openai/gpt-oss-20b:free'],
    async (_prompt, _host, model) => {
      calls.push(model);
      return model === 'openrouter/free'
        ? { voiceover: 'missing scenes' }
        : {
            hooks: ['Hook'],
            voiceover: 'Narration',
            scenes: [{
              visual: 'Topic visual',
              voiceover: 'Scene narration',
              source_fact: 'Article fact'
            }]
          };
    },
    (value) => validateGeneratedResult('video_scenario', value)
  );
  assert.deepEqual(calls, ['openrouter/free', 'openai/gpt-oss-20b:free']);
  assert.equal(generated.model, 'openai/gpt-oss-20b:free');
});

test('extracts article text and parses fenced JSON', () => {
  const wiki = extractWikiText('<html><h1>Solana</h1><main><p>Solana is a blockchain network with enough useful article text for extraction and generation.</p></main></html>');
  assert.equal(wiki.title, 'Solana');
  assert.match(wiki.rawText, /blockchain network/);
  assert.deepEqual(parseStrictJson('```json\n{"ok":true}\n```'), { ok: true });
});

test('recovers JSON from common free-model formatting mistakes', () => {
  assert.deepEqual(
    parseStrictJson('Here is the requested plan:\n```json\n{"ok":true,}\n```\nDone.'),
    { ok: true }
  );
  assert.deepEqual(
    parseStrictJson('Answer: {"text":"keep }, inside strings","items":[1,2,]}'),
    { text: 'keep }, inside strings', items: [1, 2] }
  );
  assert.deepEqual(parseStrictJson('"{\\"ok\\":true}"'), { ok: true });
});

test('uses the longest article region when the first main element is empty', () => {
  const wiki = extractWikiText(`
    <html>
      <head><title>Solana - Cryptoassets | IQ.wiki</title></head>
      <body>
        <main></main>
        <main><article><h1>Solana</h1><p>Solana is a blockchain network with readable article content.</p></article></main>
      </body>
    </html>
  `);
  assert.equal(wiki.title, 'Solana');
  assert.match(wiki.rawText, /readable article content/);
});

test('normalizes free-provider response formats', () => {
  assert.deepEqual(parseStrictJson({ ok: true }), { ok: true });
  assert.equal(extractModelContent({
    choices: [{ message: { content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] } }]
  }), '{"ok":true}');
  assert.throws(() => parseStrictJson([]), /invalid data/);
  assert.throws(() => extractModelContent({ choices: [] }), /no usable content/);
});
