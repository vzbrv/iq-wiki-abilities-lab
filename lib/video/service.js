import { randomUUID } from 'node:crypto';
import { AppError, assertIqWikiUrl } from '../foundation.js';
import { VIDEO_DURATION_SECONDS, VIDEO_STYLE } from './profile.js';
import { MockVideoProvider } from './providers/mock.js';

export class MemoryVideoJobStore {
  constructor() {
    this.jobs = new Map();
  }

  get(id) {
    return this.jobs.get(id);
  }

  set(job) {
    this.jobs.set(job.id, job);
    return job;
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
    const normalized = validateInput(input);
    this.ledger.reserve(this.config.maxJobUsd, this.config.dailyCapUsd);
    try {
      const providerJob = await this.provider.create(normalized);
      return publicJob(this.store.set({
        id: randomUUID(),
        providerJobId: providerJob.providerJobId,
        provider: this.config.provider,
        model: this.config.model,
        state: providerJob.state || 'queued',
        progress: 0,
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
      const update = await this.provider.poll(job.providerJobId);
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
      const next = await this.provider.create(job.input);
      Object.assign(job, {
        providerJobId: next.providerJobId,
        state: next.state || 'queued',
        progress: 0,
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
  if (!provider) {
    throw new AppError(503, 'VIDEO_PROVIDER_NOT_IMPLEMENTED', 'The configured video provider is not implemented.');
  }
  return new VideoJobService({ config, provider });
}

function validateInput(input = {}) {
  const article = input.article || {};
  const scenario = input.scenario || {};
  if (!article.title || !article.url) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Article title and URL are required.');
  }
  if (!scenario.voiceover || !Array.isArray(scenario.scenes) || scenario.scenes.length === 0) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'A generated narration and scene plan are required.');
  }
  if (input.duration !== undefined && Number(input.duration) !== VIDEO_DURATION_SECONDS) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Duration is fixed at 15 seconds.');
  }
  if (input.style !== undefined && input.style !== VIDEO_STYLE) {
    throw new AppError(400, 'INVALID_VIDEO_INPUT', 'Style is fixed to cinematic explainer.');
  }
  return {
    article: { title: String(article.title).slice(0, 200), url: assertIqWikiUrl(article.url) },
    scenario: {
      voiceover: String(scenario.voiceover).slice(0, 4000),
      scenes: scenario.scenes.slice(0, 12)
    },
    duration: VIDEO_DURATION_SECONDS,
    style: VIDEO_STYLE,
    testFailure: Boolean(input.testFailure)
  };
}

function publicJob(job) {
  const { providerJobId, input, ...visible } = job;
  return { ...visible };
}
