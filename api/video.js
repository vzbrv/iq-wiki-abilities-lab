import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError, readJsonBody } from '../lib/foundation.js';
import { getVideoConfig, publicVideoConfig } from '../lib/video/config.js';
import { createVideoLibraryStore, VideoLibraryService } from '../lib/video/library.js';
import { createVideoService } from '../lib/video/service.js';

let runtime;

export default async function handler(req, res) {
  const requestId = randomUUID();
  setHeaders(req, res, requestId);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) {
    return sendError(res, requestId, new AppError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.'));
  }

  const startedAt = Date.now();
  try {
    const current = getRuntime();
    const queryAction = req.query?.action;
    if (req.method === 'GET' && (queryAction === 'capabilities' || (!queryAction && !req.query?.id))) {
      return res.status(200).json({ video: publicVideoConfig(current.config), requestId });
    }
    if (req.method === 'GET' && queryAction === 'lookup') {
      const video = await current.library.lookup(req.query?.url);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      return res.status(200).json({ video, requestId });
    }

    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const action = body.action || req.query?.action || 'poll';
    if (req.method === 'GET' && action !== 'poll') {
      throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Use POST for video changes.');
    }
    if (action === 'sync_article' || action === 'publish_asset') {
      assertLibraryToken(req);
      const video = action === 'sync_article'
        ? await current.library.syncArticle(body.article)
        : await current.library.publishAsset(body);
      log('video_library_updated', { requestId, action, state: video.state, durationMs: Date.now() - startedAt });
      return res.status(200).json({ video, requestId });
    }
    const id = body.id || req.query?.id;
    let job;
    if (action === 'generate') job = await current.service.createJob(body);
    else if (action === 'retry') job = await current.service.retryJob(id);
    else if (action === 'cancel') job = await current.service.cancelJob(id);
    else if (action === 'poll') job = await current.service.getJob(id, true);
    else throw new AppError(400, 'INVALID_VIDEO_ACTION', 'Invalid video action.');

    log('video_request_complete', { requestId, action, jobId: job.id, state: job.state, durationMs: Date.now() - startedAt });
    return res.status(200).json({ job, requestId });
  } catch (error) {
    log('video_request_failed', {
      requestId,
      code: error.code || 'INTERNAL_ERROR',
      status: error.status || 500,
      durationMs: Date.now() - startedAt
    });
    return sendError(res, requestId, error);
  }
}

function getRuntime() {
  if (!runtime) {
    const config = getVideoConfig();
    runtime = {
      config,
      service: createVideoService(config),
      library: new VideoLibraryService(createVideoLibraryStore())
    };
  }
  return runtime;
}

function setHeaders(req, res, requestId) {
  const origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
}

function assertLibraryToken(req) {
  const expected = process.env.VIDEO_LIBRARY_SYNC_TOKEN;
  if (!expected) {
    throw new AppError(503, 'VIDEO_LIBRARY_SYNC_NOT_CONFIGURED', 'Video library publishing is not configured.');
  }
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid video library token.');
  }
}

function sendError(res, requestId, error) {
  const status = error.status || 500;
  return res.status(status).json({
    error: status === 500 ? 'Unexpected server error.' : error.message,
    code: error.code || 'INTERNAL_ERROR',
    retryable: Boolean(error.retryable),
    requestId
  });
}

function log(event, details) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}
