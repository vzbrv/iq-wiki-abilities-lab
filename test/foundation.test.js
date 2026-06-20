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
  getOpenRouterReferer,
  readJsonBody,
  readPositiveInteger,
  parseStrictJson
} from '../lib/foundation.js';
import {
  buildGenerationCacheKey,
  buildPrompt,
  buildOpenRouterPayload,
  callOpenRouter,
  getConfiguredModels,
  readResponseText,
  reuseInflight,
  validateGeneratedResult
} from '../api/generate.js';

test('hardcodes the 15-second cinematic explainer profile', () => {
  const prompt = buildPrompt('video_scenario', {
    title: 'Solana',
    url: 'https://iq.wiki/wiki/solana',
    rawText: 'Solana is a blockchain designed for fast transactions.'
  });

  assert.match(prompt, /15-second/);
  assert.match(prompt, /cinematic and explanatory, easy to understand, and entertaining/);
  assert.doesNotMatch(prompt, /20-second|30-second|documentary/);
});

test('limits article text sent to free models', () => {
  const prompt = buildPrompt('video_scenario', {
    title: 'Solana',
    url: 'https://iq.wiki/wiki/solana',
    rawText: `${'a'.repeat(14000)}SECRET_TAIL`
  });

  assert.doesNotMatch(prompt, /SECRET_TAIL/);
});

test('accepts direct HTTPS IQ.wiki article URLs', () => {
  assert.equal(
    assertIqWikiUrl('https://iq.wiki/wiki/solana?utm_source=test#history'),
    'https://iq.wiki/wiki/solana'
  );
});

test('accepts localized IQ.wiki article URLs', () => {
  assert.equal(
    assertIqWikiUrl('https://iq.wiki/kr/wiki/ethereum?utm_source=test'),
    'https://iq.wiki/kr/wiki/ethereum'
  );
  assert.equal(
    assertIqWikiUrl('https://iq.wiki/zh/wiki/bitcoin'),
    'https://iq.wiki/zh/wiki/bitcoin'
  );
});

test('rejects non-IQ.wiki and non-article URLs', () => {
  assert.throws(() => assertIqWikiUrl('https://example.com/wiki/solana'), AppError);
  assert.throws(() => assertIqWikiUrl('https://attacker.iq.wiki/wiki/solana'), AppError);
  assert.throws(() => assertIqWikiUrl('https://iq.wiki/rank/cryptocurrencies'), AppError);
  assert.throws(() => assertIqWikiUrl('https://iq.wiki/wiki/'), AppError);
});

test('enforces JSON object type and size after platform parsing', async () => {
  assert.deepEqual(await readJsonBody({ body: { action: 'load_wiki' } }), { action: 'load_wiki' });
  await assert.rejects(readJsonBody({ body: [] }), { code: 'INVALID_JSON' });
  await assert.rejects(readJsonBody({ body: '[]' }), { code: 'INVALID_JSON' });
  await assert.rejects(
    readJsonBody({ body: { value: 'x'.repeat(70000) } }),
    { code: 'REQUEST_TOO_LARGE' }
  );
});

test('uses only a configured trusted URL for OpenRouter attribution', () => {
  assert.equal(getOpenRouterReferer({}), 'https://iq.wiki');
  assert.equal(
    getOpenRouterReferer({ VERCEL_URL: 'iq-wiki.example' }),
    'https://iq-wiki.example'
  );
  assert.equal(
    getOpenRouterReferer({ PUBLIC_APP_URL: 'http://attacker.example' }),
    'https://iq.wiki'
  );
});

test('stops reading IQ.wiki responses at the byte limit', async () => {
  assert.equal(await readResponseText(new Response('article'), 7), 'article');
  await assert.rejects(
    readResponseText(new Response('éééé'), 7),
    { code: 'WIKI_TOO_LARGE', status: 413 }
  );
});

test('does not require provider-specific JSON mode from free models', () => {
  const payload = buildOpenRouterPayload('prompt', 'openrouter/free');
  assert.equal(payload.model, 'openrouter/free');
  assert.equal('response_format' in payload, false);
  assert.match(payload.messages[0].content, /JSON object/);
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

test('keeps built-in free fallbacks when models are configured', () => {
  const models = getConfiguredModels({
    OPENROUTER_MODELS: 'meta-llama/custom-model:free'
  });
  assert.equal(models[0], 'openrouter/free');
  assert.ok(models.includes('meta-llama/custom-model:free'));
  assert.ok(models.includes('openai/gpt-oss-120b:free'));
  assert.equal(models.every((model) => model === 'openrouter/free' || model.endsWith(':free')), true);
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

test('tries every free model and distinguishes non-quota failures', async () => {
  const models = [
    'openrouter/free',
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'openai/gpt-oss-120b:free'
  ];
  const calls = [];
  await assert.rejects(
    callOpenRouter('prompt', 'example.com', models, async (_prompt, _host, model, timeoutMs) => {
      calls.push({ model, timeoutMs });
      throw new AppError(504, 'FREE_MODEL_TIMEOUT', 'timeout', true);
    }),
    (error) => error.code === 'FREE_MODELS_UNAVAILABLE' && error.status === 503
  );
  assert.deepEqual(calls.map(({ model }) => model), models);
  assert.equal(calls[0].timeoutMs, 24000);
  assert.equal(calls.slice(1).every(({ timeoutMs }) => timeoutMs >= 1000 && timeoutMs <= 12000), true);
});

test('reports capacity only when every free model rejects for quota', async () => {
  await assert.rejects(
    callOpenRouter('prompt', 'example.com', [
      'openai/gpt-oss-20b:free',
      'openrouter/free'
    ], async () => {
      throw new AppError(429, 'FREE_MODEL_QUOTA', 'capacity', true);
    }),
    (error) => error.code === 'FREE_MODELS_EXHAUSTED' && error.status === 429
  );
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

test('rate limiter bounds retained visitor entries', () => {
  const limit = createRateLimiter({ limit: 1, windowMs: 60_000, maxEntries: 2 });
  assert.equal(limit('visitor-a').allowed, true);
  assert.equal(limit('visitor-b').allowed, true);
  assert.equal(limit('visitor-c').allowed, true);
  assert.equal(limit('visitor-a').allowed, true);
});

test('sanitizes malformed positive integer settings', () => {
  assert.equal(readPositiveInteger('bad', 8), 8);
  assert.equal(readPositiveInteger('0', 8), 8);
  assert.equal(readPositiveInteger('-2', 8), 8);
  assert.equal(readPositiveInteger('3', 8), 3);

  const limit = createRateLimiter({ limit: 'bad', windowMs: 0, maxEntries: -1 });
  assert.equal(limit('visitor').allowed, true);
  assert.equal(limit('visitor').allowed, false);
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
  const normalized = validateGeneratedResult('video_scenario', {
    hook: 'Hook',
    narration: Array.from({ length: 50 }, () => 'word').join(' '),
    scenes: [{
      timestamp: '0-15s',
      visual_direction: 'Show the protocol interface',
      on_screen_text: 'one two three four five six',
      narration: 'Scene narration',
      fact: 'The article says the protocol launched.'
    }]
  });
  assert.deepEqual(normalized.hooks, ['Hook']);
  assert.equal(normalized.voiceover.split(' ').length, 42);
  assert.equal(normalized.scenes[0].caption, 'one two three four five');
  const derivedNarration = validateGeneratedResult('video_scenario', {
    hooks: ['Hook'],
    voiceover: '',
    scenes: [{
      visual: 'Show the protocol interface',
      voiceover: 'Use this scene narration',
      source_fact: 'The article says the protocol launched.'
    }]
  });
  assert.equal(derivedNarration.voiceover, 'Use this scene narration');
  const aliases = validateGeneratedResult('video_scenario', {
    script: 'A concise grounded narration for this article',
    storyboard: [{
      timestamp: '0-15s',
      description: 'Show topic-specific footage',
      text: 'Simple label',
      script: 'Scene narration',
      supporting_fact: 'Article fact'
    }]
  });
  assert.deepEqual(aliases.hooks, ['A concise grounded narration for this article']);
  assert.equal(aliases.scenes[0].visual, 'Show topic-specific footage');
  assert.equal(aliases.scenes[0].source_fact, 'Article fact');
  assert.throws(
    () => validateGeneratedResult('video_scenario', {
      hooks: 'Hook',
      voiceover: 'Narration',
      scenes: []
    }),
    /incomplete answer/
  );
  assert.throws(
    () => validateGeneratedResult('video_scenario', {
      hooks: ['Hook'],
      voiceover: 'Narration',
      scenes: [{
        visual: 'Show the protocol interface',
        voiceover: 'Scene narration'
      }]
    }),
    (error) => error.code === 'INVALID_MODEL_RESPONSE'
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

test('generation cache keys change with article content', () => {
  const wiki = {
    title: 'Solana',
    url: 'https://iq.wiki/wiki/solana',
    rawText: 'First article version'
  };
  const models = ['openrouter/free'];
  const first = buildGenerationCacheKey('video_scenario', wiki, models);
  const second = buildGenerationCacheKey(
    'video_scenario',
    { ...wiki, rawText: 'Materially updated article version' },
    models
  );
  assert.notEqual(first, second);
});

test('shares concurrent generation and clears completed requests', async () => {
  const inflight = new Map();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const create = async () => {
    calls += 1;
    await gate;
    return 42;
  };

  const first = reuseInflight(inflight, 'same', create);
  const second = reuseInflight(inflight, 'same', create);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(inflight.size, 0);

  await assert.rejects(
    reuseInflight(inflight, 'failed', async () => {
      throw new Error('failed');
    }),
    /failed/
  );
  assert.equal(inflight.size, 0);
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
    choices: [{ text: '{"ok":true}' }]
  }), '{"ok":true}');
  assert.equal(extractModelContent({
    choices: [{ message: { content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] } }]
  }), '{"ok":true}');
  assert.throws(() => parseStrictJson([]), /invalid data/);
  assert.throws(() => extractModelContent({ choices: [] }), /no usable content/);
});
