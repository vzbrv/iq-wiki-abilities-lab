import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../lib/foundation.js';
import { getVideoConfig, publicVideoConfig } from '../lib/video/config.js';
import { VIDEO_DURATION_SECONDS, VIDEO_STYLE } from '../lib/video/profile.js';
import { MockVideoProvider } from '../lib/video/providers/mock.js';
import { MemoryVideoJobStore, VideoJobService, createVideoService } from '../lib/video/service.js';
import { sendError } from '../api/video.js';

const input = {
  article: { title: 'Ethereum', url: 'https://iq.wiki/wiki/ethereum' },
  scenario: {
    voiceover: 'Ethereum is a programmable blockchain.',
    scenes: Array.from({ length: 3 }, (_, index) => ({
      time: 'ignored',
      visual: `Ethereum network ${index + 1}`,
      caption: 'Ethereum',
      voiceover: `Scene ${index + 1}`,
      source_fact: `Ethereum fact ${index + 1}`
    }))
  },
  duration: VIDEO_DURATION_SECONDS,
  style: VIDEO_STYLE
};

function config(overrides = {}) {
  return {
    enabled: true,
    status: 'ready',
    provider: 'mock',
    model: 'mock-video-v1',
    maxJobUsd: 0,
    dailyCapUsd: 0,
    credential: 'must-not-leak',
    ...overrides
  };
}

test('video engine is disabled by default', () => {
  assert.deepEqual(getVideoConfig({}), {
    enabled: false,
    status: 'not_configured',
    provider: null,
    model: null
  });
});

test('disabled video engine exposes no actions', () => {
  assert.deepEqual(publicVideoConfig(getVideoConfig({})).actions, []);
});

test('mock provider is forbidden in production', () => {
  assert.throws(() => getVideoConfig({
    VIDEO_ENGINE_ENABLED: 'true',
    VIDEO_PROVIDER: 'mock',
    VIDEO_PROVIDER_ALLOWLIST: 'mock',
    VIDEO_MODEL: 'mock-video-v1',
    VIDEO_MODEL_ALLOWLIST: 'mock-video-v1',
    VIDEO_MOCK_ENABLED: 'true',
    NODE_ENV: 'production'
  }), { code: 'VIDEO_MOCK_FORBIDDEN' });
});

test('model must be explicitly allowlisted', () => {
  assert.throws(() => getVideoConfig({
    VIDEO_ENGINE_ENABLED: 'true',
    VIDEO_PROVIDER: 'mock',
    VIDEO_PROVIDER_ALLOWLIST: 'mock',
    VIDEO_MODEL: 'unapproved',
    VIDEO_MODEL_ALLOWLIST: 'approved',
    VIDEO_MOCK_ENABLED: 'true'
  }), { code: 'VIDEO_MODEL_BLOCKED' });
});

test('external providers require explicit spending caps', () => {
  const env = {
    VIDEO_ENGINE_ENABLED: 'true',
    VIDEO_PROVIDER: 'future',
    VIDEO_PROVIDER_ALLOWLIST: 'future',
    VIDEO_MODEL: 'future-video-v1',
    VIDEO_MODEL_ALLOWLIST: 'future-video-v1',
    VIDEO_API_KEY: 'secret'
  };

  assert.throws(() => getVideoConfig(env), { code: 'VIDEO_CONFIGURATION_ERROR' });
  assert.equal(getVideoConfig({
    ...env,
    VIDEO_MAX_JOB_USD: '0.50',
    VIDEO_DAILY_CAP_USD: '5'
  }).status, 'ready');
  assert.throws(() => getVideoConfig({
    ...env,
    VIDEO_MAX_JOB_USD: '0.50',
    VIDEO_DAILY_CAP_USD: '5',
    NODE_ENV: 'production'
  }), { code: 'VIDEO_DURABLE_STATE_REQUIRED' });
});

test('video provider timeout is bounded', () => {
  const env = {
    VIDEO_ENGINE_ENABLED: 'true',
    VIDEO_PROVIDER: 'mock',
    VIDEO_PROVIDER_ALLOWLIST: 'mock',
    VIDEO_MODEL: 'mock-video-v1',
    VIDEO_MODEL_ALLOWLIST: 'mock-video-v1',
    VIDEO_MOCK_ENABLED: 'true'
  };

  assert.equal(getVideoConfig(env).providerTimeoutMs, 30000);
  assert.throws(
    () => getVideoConfig({ ...env, VIDEO_PROVIDER_TIMEOUT_MS: '0' }),
    { code: 'VIDEO_CONFIGURATION_ERROR' }
  );
});

test('memory job store expires old jobs and remains bounded', () => {
  let now = 1000;
  const store = new MemoryVideoJobStore({ maxEntries: 2, ttlMs: 100, now: () => now });

  const first = { id: 'first', state: 'queued', createdAt: new Date(now).toISOString() };
  store.set(first);
  first.state = 'failed';
  const retrieved = store.get('first');
  retrieved.state = 'cancelled';
  assert.equal(store.get('first').state, 'queued');
  store.set({ id: 'second', createdAt: new Date(now).toISOString() });
  store.set({ id: 'third', createdAt: new Date(now).toISOString() });

  assert.equal(store.get('first'), undefined);
  assert.equal(store.get('second').id, 'second');
  assert.equal(store.get('third').id, 'third');

  now += 101;
  store.set({ id: 'fresh', createdAt: new Date(now).toISOString() });
  assert.equal(store.get('first'), undefined);
  assert.equal(store.get('third'), undefined);
  assert.equal(store.get('fresh').id, 'fresh');
});

test('memory job store rejects invalid limits and records', () => {
  assert.throws(() => new MemoryVideoJobStore({ maxEntries: 0 }), TypeError);
  assert.throws(() => new MemoryVideoJobStore({ ttlMs: 1.5 }), TypeError);
  assert.throws(() => new MemoryVideoJobStore({ now: null }), TypeError);
  assert.throws(() => new MemoryVideoJobStore().set({}), TypeError);
});

test('provider integrations must implement the full lifecycle', () => {
  assert.throws(
    () => createVideoService(config({ provider: 'future' }), {
      future: { async create() { return {}; } }
    }),
    { code: 'VIDEO_PROVIDER_NOT_IMPLEMENTED' }
  );
});

test('video jobs require narration for every scene', async () => {
  const service = createVideoService(config(), {
    mock: new MockVideoProvider()
  });
  const invalid = structuredClone(input);
  invalid.scenario.scenes[1].voiceover = '';
  await assert.rejects(service.createJob(invalid), { code: 'INVALID_VIDEO_INPUT' });
});

test('job lifecycle supports polling, playback, cancellation, and retry', async () => {
  const service = new VideoJobService({ config: config(), provider: new MockVideoProvider() });
  const created = await service.createJob(input);
  assert.equal(created.state, 'queued');
  assert.equal((await service.getJob(created.id)).state, 'processing');
  const completed = await service.getJob(created.id);
  assert.equal(completed.state, 'completed');
  assert.match(completed.playbackUrl, /^https:/);

  const cancellable = await service.createJob(input);
  assert.equal((await service.cancelJob(cancellable.id)).state, 'cancelled');
  const retried = await service.retryJob(cancellable.id);
  assert.equal(retried.state, 'queued');
  assert.equal(retried.attempt, 2);
});

test('rejects duration and style overrides', async () => {
  const service = new VideoJobService({ config: config(), provider: new MockVideoProvider() });
  await assert.rejects(
    service.createJob({ ...input, duration: 20 }),
    { code: 'INVALID_VIDEO_INPUT' }
  );
  await assert.rejects(
    service.createJob({ ...input, style: 'technical' }),
    { code: 'INVALID_VIDEO_INPUT' }
  );
});

test('rejects incomplete or malformed video plans', async () => {
  const service = new VideoJobService({ config: config(), provider: new MockVideoProvider() });
  await assert.rejects(
    service.createJob({
      ...input,
      scenario: { ...input.scenario, scenes: input.scenario.scenes.slice(0, 2) }
    }),
    { code: 'INVALID_VIDEO_INPUT' }
  );
  await assert.rejects(
    service.createJob({
      ...input,
      scenario: {
        ...input.scenario,
        scenes: input.scenario.scenes.map((scene) => ({ ...scene, source_fact: '' }))
      }
    }),
    { code: 'INVALID_VIDEO_INPUT' }
  );
});

test('normalizes scenes and strips mock-only flags for real providers', async () => {
  let providerInput;
  const provider = {
    async create(value) {
      providerInput = value;
      return { providerJobId: 'provider-job', state: 'queued' };
    }
  };
  const service = new VideoJobService({
    config: config({ provider: 'future' }),
    provider
  });

  await service.createJob({ ...input, testFailure: true });

  assert.deepEqual(providerInput.scenario.scenes.map((scene) => scene.time), ['0-5s', '5-10s', '10-15s']);
  assert.equal('testFailure' in providerInput, false);
});

test('rejects malformed provider create and polling responses', async () => {
  const invalidCreate = new VideoJobService({
    config: config({ provider: 'future' }),
    provider: { async create() { return { state: 'queued' }; } }
  });
  await assert.rejects(invalidCreate.createJob(input), { code: 'VIDEO_PROVIDER_INVALID_RESPONSE' });

  const invalidPoll = new VideoJobService({
    config: config({ provider: 'future' }),
    provider: {
      async create() {
        return { providerJobId: 'provider-job', state: 'queued' };
      },
      async poll() {
        return { state: 'completed' };
      }
    }
  });
  const job = await invalidPoll.createJob(input);
  await assert.rejects(invalidPoll.getJob(job.id), { code: 'VIDEO_PROVIDER_INVALID_RESPONSE' });

  const invalidPlayback = new VideoJobService({
    config: config({ provider: 'future' }),
    provider: {
      async create() {
        return { providerJobId: 'provider-job', state: 'queued' };
      },
      async poll() {
        return { state: 'completed', playbackUrl: 'javascript:alert(1)' };
      }
    }
  });
  const playbackJob = await invalidPlayback.createJob(input);
  await assert.rejects(
    invalidPlayback.getJob(playbackJob.id),
    { code: 'VIDEO_PROVIDER_INVALID_RESPONSE' }
  );

  const privatePlayback = new VideoJobService({
    config: config({ provider: 'future' }),
    provider: {
      async create() {
        return { providerJobId: 'provider-job', state: 'queued' };
      },
      async poll() {
        return { state: 'completed', playbackUrl: 'https://127.0.0.1/video.mp4' };
      }
    }
  });
  const privatePlaybackJob = await privatePlayback.createJob(input);
  await assert.rejects(
    privatePlayback.getJob(privatePlaybackJob.id),
    { code: 'VIDEO_PROVIDER_INVALID_RESPONSE' }
  );
});

test('normalizes provider failures and malformed job IDs', async () => {
  const service = new VideoJobService({
    config: config({ provider: 'future' }),
    provider: {
      async create() {
        throw new AppError(418, 'PROVIDER_SECRET', 'Provider detail');
      }
    }
  });

  await assert.rejects(
    service.createJob(input),
    (error) =>
      error.code === 'VIDEO_PROVIDER_UNAVAILABLE' &&
      error.status === 503 &&
      error.retryable === true
  );
  await assert.rejects(
    service.getJob('../secret'),
    (error) => error.code === 'INVALID_VIDEO_JOB_ID' && error.status === 400
  );
});

test('times out provider calls and hides provider failure details', async () => {
  const hanging = new VideoJobService({
    config: config({ provider: 'future', providerTimeoutMs: 5 }),
    provider: {
      create() {
        return new Promise(() => {});
      }
    }
  });
  await assert.rejects(
    hanging.createJob(input),
    (error) => error.code === 'VIDEO_PROVIDER_UNAVAILABLE' && error.retryable === true
  );

  const failing = new VideoJobService({
    config: config({ provider: 'future' }),
    provider: {
      async create() {
        return { providerJobId: 'provider-job', state: 'queued' };
      },
      async poll() {
        return { state: 'failed', error: 'secret provider diagnostic' };
      }
    }
  });
  const job = await failing.createJob(input);
  const failed = await failing.getJob(job.id);
  assert.equal(failed.error, 'Video generation failed.');
  assert.doesNotMatch(JSON.stringify(failed), /secret provider diagnostic/);
});

test('provider polling cannot move jobs backwards or reduce progress', async () => {
  const provider = {
    polls: 0,
    async create() {
      return { providerJobId: 'provider-job', state: 'processing', progress: 60 };
    },
    async poll() {
      this.polls += 1;
      return this.polls === 1
        ? { state: 'processing', progress: 20 }
        : { state: 'queued', progress: 80 };
    }
  };
  const service = new VideoJobService({
    config: config({ provider: 'future' }),
    provider
  });
  const created = await service.createJob(input);

  assert.equal((await service.getJob(created.id)).progress, 60);
  await assert.rejects(
    service.getJob(created.id),
    { code: 'VIDEO_PROVIDER_INVALID_RESPONSE' }
  );
});

test('rejects oversized video plan fields', async () => {
  const service = new VideoJobService({ config: config(), provider: new MockVideoProvider() });
  await assert.rejects(
    service.createJob({
      ...input,
      article: { ...input.article, title: 'x'.repeat(201) }
    }),
    { code: 'INVALID_VIDEO_INPUT' }
  );
  await assert.rejects(
    service.createJob({
      ...input,
      scenario: {
        ...input.scenario,
        scenes: input.scenario.scenes.map((scene) => ({
          ...scene,
          visual: 'x'.repeat(1001)
        }))
      }
    }),
    { code: 'INVALID_VIDEO_INPUT' }
  );
});

test('credentials and provider job IDs are never public', async () => {
  const current = config();
  const service = new VideoJobService({ config: current, provider: new MockVideoProvider() });
  const job = await service.createJob(input);
  assert.equal(JSON.stringify(job).includes('must-not-leak'), false);
  assert.equal('providerJobId' in job, false);
  assert.equal('credential' in publicVideoConfig(current), false);
});

test('unexpected video errors cannot control the public response', () => {
  const response = {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    }
  };

  sendError(response, 'request-id', Object.assign(new Error('secret'), { status: 400 }));

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'Unexpected server error.');
  assert.equal(response.body.code, 'INTERNAL_ERROR');
});
