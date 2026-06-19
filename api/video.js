import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/foundation.js';
import { getVideoConfig, publicVideoConfig } from '../lib/video/config.js';
import { createVideoService } from '../lib/video/service.js';

let runtime;

export default async function handler(req, res) {
  const requestId = randomUUID();
  setHeaders(res, requestId);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) {
    return sendError(res, requestId, new AppError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.'));
  }

  const startedAt = Date.now();
  try {
    const current = getRuntime();
    if (req.method === 'GET' && (!req.query?.id || req.query?.action === 'capabilities')) {
      return res.status(200).json({ video: publicVideoConfig(current.config), requestId });
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    const action = body.action || req.query?.action || 'poll';
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
    runtime = { config, service: createVideoService(config) };
  }
  return runtime;
}

function setHeaders(res, requestId) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new AppError(413, 'REQUEST_TOO_LARGE', 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
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
