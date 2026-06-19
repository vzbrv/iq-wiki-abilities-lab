import test from 'node:test';
import assert from 'node:assert/strict';
import { getVideoConfig, publicVideoConfig } from '../lib/video/config.js';
import { MockVideoProvider } from '../lib/video/providers/mock.js';
import { VideoJobService } from '../lib/video/service.js';

const input = {
  article: { title: 'Ethereum', url: 'https://iq.wiki/wiki/ethereum' },
  scenario: { voiceover: 'Ethereum is a programmable blockchain.', scenes: [{ visual: 'Ethereum network' }] },
  duration: 20,
  style: 'technical'
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

test('credentials and provider job IDs are never public', async () => {
  const current = config();
  const service = new VideoJobService({ config: current, provider: new MockVideoProvider() });
  const job = await service.createJob(input);
  assert.equal(JSON.stringify(job).includes('must-not-leak'), false);
  assert.equal('providerJobId' in job, false);
  assert.equal('credential' in publicVideoConfig(current), false);
});
