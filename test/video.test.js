import test from 'node:test';
import assert from 'node:assert/strict';
import { getVideoConfig, publicVideoConfig } from '../lib/video/config.js';
import { VIDEO_DURATION_SECONDS, VIDEO_STYLE } from '../lib/video/profile.js';
import { MockVideoProvider } from '../lib/video/providers/mock.js';
import { VideoJobService } from '../lib/video/service.js';
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
