import { randomUUID } from 'node:crypto';
import { AppError, assertIqWikiUrl } from '../foundation.js';
import { VIDEO_DURATION_SECONDS, VIDEO_STYLE } from './profile.js';
import { MockVideoProvider } from './providers/mock.js';

const VIDEO_SCENE_TIMES = ['0-5s', '5-10s', '10-15s'];
const VIDEO_JOB_STATES = new Set(['queued', 'processing', 'completed', 'failed', 'cancelled']);

export class MemoryVideoJobStore {
  constructor({ maxEntries = 500, ttlMs = 86400000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new TypeError('ttlMs must be a positive safe integer.');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.jobs = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(id) {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) return undefined;
    this.jobs.delete(id);
    this.jobs.set(id, job);
    return structuredClone(job);
  }

  set(job) {
    if (!job || typeof job !== 'object' || Array.isArray(job) || typeof job.id !== 'string' || !job.id) {
      throw new TypeError('job must contain a non-empty string id.');
    }
    this.prune();
    const stored = structuredClone(job);
    this.jobs.delete(stored.id);
    while (this.jobs.size >= this.maxEntries) {
      this.jobs.delete(this.jobs.keys().next().value);
    }
    this.jobs.set(stored.id, stored);
    return structuredClone(stored);
  }

  prune() {
    const expiresAt = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      const timestamp = Date.parse(job.updatedAt || job.createdAt);
      if (!Number.isFinite(timestamp) || timestamp <= expiresAt) this.jobs.delete(id);
    }
  }
}

export class MemorySpendLedger {
  constructor() {
    this.day = '';
    this.reserved = 0;
  }

  reserve(amount, cap) {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.reserved = 0;
    }
    if (this.reserved + amount > cap) {
      throw new AppError(429, 'VIDEO_SPENDING_CAP', 'The video generation spending cap has been reached.');
    }
    this.reserved += amount;
  }

  release(amount) {
    this.reserved = Math.max(0, this.reserved - amount);
  }
}

export class VideoJobService {
  constructor({ config, provider, store = new MemoryVideoJobStore(), ledger = new MemorySpendLedger() }) {
    this.config = config;
    this.provider = provider;
    this.store = store;
    this.ledger = ledger;
  }

  async createJob(input) {
    this.assertEnabled();
    const normalized = validateInput(input, {
      allowTestFailure: this.config.provider === 'mock'
    });
    this.ledger.reserve(this.config.maxJobUsd, this.config.dailyCapUsd);
    try {
      const providerJob = normalizeCreatedProviderJob(await this.provider.create(normalized));
      return publicJob(this.store.set({
        id: randomUUID(),
        providerJobId: providerJob.providerJobId,
        provider: this.config.provider,
        model: this.config.model,
        state: providerJob.state || 'queued',
        progress: providerJob.progress,
        attempt: 1,
        costLimitUsd: this.config.maxJobUsd,
        input: normalized,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));
    } catch (error) {
      this.ledger.release(this.config.maxJobUsd);
      throw error;
    }
  }

  async getJob(id, refresh = true) {
    const job = this.requireJob(id);
    if (refresh && ['queued', 'processing'].includes(job.state)) {
      const update = normalizeProviderUpdate(
        await this.provider.poll(job.providerJobId),
        job.progress,
        job.state
      );
      Object.assign(job, {
        state: update.state,
        progress: update.progress ?? job.progress,
        playbackUrl: update.playbackUrl,
        error: update.error,
        updatedAt: new Date().toISOString()
      });
      this.store.set(job);
    }
    return publicJob(job);
  }

  async retryJob(id) {
    this.assertEnabled();
    const job = this.requireJob(id);
    if (!['failed', 'cancelled'].includes(job.state)) {
      throw new AppError(409, 'VIDEO_JOB_NOT_RETRYABLE', 'Only failed or cancelled jobs can be retried.');
    }
    this.ledger.reserve(this.config.maxJobUsd, this.config.dailyCapUsd);
    try {
      const next = normalizeCreatedProviderJob(await this.provider.create(job.input));
      Object.assign(job, {
        providerJobId: next.providerJobId,
        state: next.state || 'queued',
        progress: next.progress,
        attempt: job.attempt + 1,
        playbackUrl: undefined,
        error: undefined,
        updatedAt: new Date().toISOString()
      });
      return publicJob(this.store.set(job));
    } catch (error) {
      this.ledger.release(this.config.maxJobUsd);
      throw error;
    }
  }

  async cancelJob(id) {
    const job = this.requireJob(id);
    if (!['queued', 'processing'].includes(job.state)) {
      throw new AppError(409, 'VIDEO_JOB_NOT_CANCELLABLE', 'This video job cannot be cancelled.');
    }
    await this.provider.cancel(job.providerJobId);
    job.state = 'cancelled';
    job.updatedAt = new Date().toISOString();
    return publicJob(this.store.set(job));
  }

  assertEnabled() {
    if (!this.config.enabled) {
      throw new AppError(503, 'VIDEO_ENGINE_DISABLED', 'Video engine coming soon.');
    }
  }

  requireJob(id) {
    const job = this.store.get(id);
    if (!job) throw new AppError(404, 'VIDEO_JOB_NOT_FOUND', 'Video job not found.');
    return job;
  }
}

export function createVideoService(config, providers = {}) {
  if (!config.enabled) return new VideoJobService({ config, provider: null });
  const provider = providers[config.provider]
    || (config.provider === 'mock' ? new MockVideoProvider() : null);
  const validProvider = provider
    && ['create', 'poll', 'cancel'].every((method) => typeof provider[method] === 'function');
  if (!validProvider) {
    throw new AppError(503, 'VIDEO_PROVIDER_NOT_IMPLEMENTED', 'The configured video provider is not implemented.');
  }
  return new VideoJobService({ config, provider });
}

function validateInput(input = {}, { allowTestFailure = false } = {}) {
  const article = input.article || {};
  const scenario = input.scenario || {};
  if (!article.url) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Article title and URL are required.');
  }
  if (!Array.isArray(scenario.scenes) || scenario.scenes.length !== VIDEO_SCENE_TIMES.length) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Exactly three grounded scenes are required.');
  }
  if (input.duration !== undefined && Number(input.duration) !== VIDEO_DURATION_SECONDS) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Duration is fixed at 15 seconds.');
  }
  if (input.style !== undefined && input.style !== VIDEO_STYLE) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Style is fixed to cinematic explainer.');
  }
  const normalized = {
    article: {
      title: requiredInputText(article.title, 200),
      url: assertIqWikiUrl(article.url)
    },
    scenario: {
      voiceover: requiredInputText(scenario.voiceover, 4000),
      scenes: scenario.scenes.map((scene, index) => {
        if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
          throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Every scene must be a grounded scene object.');
        }
        return {
          time: VIDEO_SCENE_TIMES[index],
          visual: requiredInputText(scene.visual, 1000),
          caption: optionalInputText(scene.caption, 300),
          voiceover: requiredInputText(scene.voiceover, 800),
          source_fact: requiredInputText(scene.source_fact, 1000)
        };
      })
    },
    duration: VIDEO_DURATION_SECONDS,
    style: VIDEO_STYLE
  };

  if (allowTestFailure && input.testFailure === true) normalized.testFailure = true;
  return normalized;
}

function requiredInputText(value, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Video input contains invalid text.');
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Video input contains text that is too long.');
  }
  return text;
}

function optionalInputText(value, maxLength) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Video input contains invalid text.');
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Video input contains text that is too long.');
  }
  return text;
}

function normalizeCreatedProviderJob(job) {
  const providerJobId = providerText(job?.providerJobId, 500);
  const state = job?.state || 'queued';
  if (!providerJobId || !['queued', 'processing'].includes(state)) {
    throw new AppError(
      502,
      'VIDEO_PROVIDER_INVALID_RESPONSE',
      'Video provider returned an invalid job.',
      true
    );
  }
  const numericProgress = Number(job?.progress);
  const progress = Number.isFinite(numericProgress)
    ? Math.min(99, Math.max(0, Math.round(numericProgress)))
    : 0;
  return { providerJobId, state, progress };
}

function normalizeProviderUpdate(update, fallbackProgress, currentState) {
  if (
    !update ||
    typeof update !== 'object' ||
    Array.isArray(update) ||
    !VIDEO_JOB_STATES.has(update.state)
  ) {
    throw new AppError(
      502,
      'VIDEO_PROVIDER_INVALID_RESPONSE',
      'Video provider returned an invalid job update.',
      true
    );
  }
  if (currentState === 'processing' && update.state === 'queued') {
    throw new AppError(
      502,
      'VIDEO_PROVIDER_INVALID_RESPONSE',
      'Video provider returned a regressive job state.',
      true
    );
  }
  const numericProgress = Number(update.progress);
  let progress = Number.isFinite(numericProgress)
    ? Math.min(100, Math.max(0, numericProgress))
    : fallbackProgress;
  progress = Math.max(fallbackProgress, progress);
  if (update.state === 'completed') progress = 100;
  const playbackUrl = update.state === 'completed'
    ? requiredPlaybackUrl(update.playbackUrl)
    : undefined;
  if (update.state === 'completed' && !playbackUrl) {
    throw new AppError(
      502,
      'VIDEO_PROVIDER_INVALID_RESPONSE',
      'Video provider completed without a playback URL.',
      true
    );
  }
  return {
    state: update.state,
    progress,
    playbackUrl,
    error: update.state === 'failed'
      ? providerText(update.error, 1000) || undefined
      : undefined
  };
}

function requiredPlaybackUrl(value) {
  const playbackUrl = providerText(value, 2000);
  if (!playbackUrl) return undefined;
  try {
    const parsed = new URL(playbackUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
    return parsed.toString();
  } catch {
    throw new AppError(
      502,
      'VIDEO_PROVIDER_INVALID_RESPONSE',
      'Video provider returned an invalid playback URL.',
      true
    );
  }
}

function providerText(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new AppError(
      502,
      'VIDEO_PROVIDER_INVALID_RESPONSE',
      'Video provider returned invalid data.',
      true
    );
  }
  return value.trim();
}

function publicJob(job) {
  const { providerJobId, input, ...visible } = job;
  return { ...visible };
}
