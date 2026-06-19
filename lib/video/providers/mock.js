import { randomUUID } from 'node:crypto';

export class MockVideoProvider {
  constructor({ playbackUrl = 'https://example.test/iq-wiki-video.mp4' } = {}) {
    this.playbackUrl = playbackUrl;
    this.jobs = new Map();
  }

  async create(input) {
    const id = randomUUID();
    this.jobs.set(id, { polls: 0, cancelled: false, fail: Boolean(input.testFailure) });
    return { providerJobId: id, state: 'queued' };
  }

  async poll(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (!job) return { state: 'failed', error: 'Mock job not found.' };
    if (job.cancelled) return { state: 'cancelled' };
    job.polls += 1;
    if (job.fail) return { state: 'failed', error: 'Requested mock failure.' };
    if (job.polls === 1) return { state: 'processing', progress: 50 };
    return { state: 'completed', progress: 100, playbackUrl: this.playbackUrl };
  }

  async cancel(providerJobId) {
    const job = this.jobs.get(providerJobId);
    if (job) job.cancelled = true;
    return { state: 'cancelled' };
  }
}
