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
  parseStrictJson
} from '../lib/foundation.js';

test('accepts direct HTTPS IQ.wiki article URLs', () => {
  assert.equal(assertIqWikiUrl('https://iq.wiki/wiki/solana#history'), 'https://iq.wiki/wiki/solana');
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

test('extracts article text and parses fenced JSON', () => {
  const wiki = extractWikiText('<html><h1>Solana</h1><main><p>Solana is a blockchain network with enough useful article text for extraction and generation.</p></main></html>');
  assert.equal(wiki.title, 'Solana');
  assert.match(wiki.rawText, /blockchain network/);
  assert.deepEqual(parseStrictJson('```json\n{"ok":true}\n```'), { ok: true });
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
