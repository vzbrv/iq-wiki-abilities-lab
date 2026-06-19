import { randomUUID } from 'node:crypto';
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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const wikiCache = new TTLCache(100);
const resultCache = new TTLCache(100);
const loadLimit = createRateLimiter({ limit: Number(process.env.LOAD_RATE_LIMIT || 20), windowMs: 300000 });
const generateLimit = createRateLimiter({ limit: Number(process.env.GENERATE_RATE_LIMIT || 8), windowMs: 600000 });

export default async function handler(req, res) {
  const requestId = randomUUID();
  setHeaders(req, res, requestId);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return sendError(res, requestId, new AppError(405, 'METHOD_NOT_ALLOWED', 'Use POST.'));

  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const action = body.action === 'short_video' ? 'video_scenario' : body.action;
    const client = getClientId(req);
    enforceRateLimit(action === 'load_wiki' ? loadLimit(client) : generateLimit(client));

    if (action === 'load_wiki') {
      const wiki = await loadWiki(body.url);
      log('request_complete', { requestId, action, status: 200, durationMs: Date.now() - startedAt });
      return res.status(200).json({ wiki, requestId });
    }
    if (!['video_scenario', 'funding_timeline', 'crypto_lore'].includes(action)) {
      throw new AppError(400, 'INVALID_ACTION', 'Invalid ability type.');
    }

    const wiki = await loadWiki(body.url);
    const model = assertFreeModel(MODEL);
    if (!process.env.OPENROUTER_API_KEY) {
      throw new AppError(503, 'CONFIGURATION_ERROR', 'Free AI generation is not configured.');
    }

    const cacheKey = JSON.stringify([action, wiki.url, body.options || {}, model]);
    let result = resultCache.get(cacheKey);
    if (!result) {
      result = await callOpenRouter(buildPrompt(action, wiki, body.options || {}), req.headers.host, model);
      resultCache.set(cacheKey, result, 900000);
    }

    log('request_complete', { requestId, action, status: 200, model, durationMs: Date.now() - startedAt });
    return res.status(200).json({
      result,
      article: { title: wiki.title, url: wiki.url, summary: wiki.summary },
      model,
      provider: 'openrouter',
      freeOnly: true,
      pipeline: action === 'video_scenario' ? {
        scenario: { provider: 'openrouter', model, freeOnly: true },
        video: { provider: null, model: null, configured: false, status: 'not_configured' }
      } : undefined,
      requestId
    });
  } catch (error) {
    log('request_failed', {
      requestId,
      status: error.status || 500,
      code: error.code || 'INTERNAL_ERROR',
      durationMs: Date.now() - startedAt
    });
    return sendError(res, requestId, error);
  }
}

function setHeaders(req, res, requestId) {
  const origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Request-Id', requestId);
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

async function loadWiki(rawUrl) {
  const url = assertIqWikiUrl(rawUrl);
  const cached = wikiCache.get(url);
  if (cached) return cached;

  const response = await fetch(url, {
    headers: { Accept: 'text/html', 'User-Agent': 'IQ.wiki Video Studio/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  }).catch((error) => {
    if (error.name === 'TimeoutError') throw new AppError(504, 'WIKI_TIMEOUT', 'IQ.wiki took too long to respond.', true);
    throw new AppError(502, 'WIKI_UNAVAILABLE', 'The IQ.wiki article could not be loaded.', true);
  });
  if (!response.ok) throw new AppError(502, 'WIKI_UNAVAILABLE', `IQ.wiki returned ${response.status}.`, true);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) throw new AppError(422, 'INVALID_WIKI_CONTENT', 'The URL did not return an HTML article.');
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > 2000000) throw new AppError(413, 'WIKI_TOO_LARGE', 'The IQ.wiki article is too large.');
  const html = await response.text();
  if (html.length > 2000000) throw new AppError(413, 'WIKI_TOO_LARGE', 'The IQ.wiki article is too large.');
  const extracted = extractWikiText(html);
  if (extracted.rawText.length < 180) {
    throw new AppError(422, 'WIKI_TEXT_MISSING', 'Not enough article text could be extracted.');
  }
  const wiki = {
    title: extracted.title || 'IQ.wiki article',
    url,
    summary: extracted.rawText.slice(0, 420),
    rawText: extracted.rawText,
    loadMode: 'live IQ.wiki article'
  };
  wikiCache.set(url, wiki, 600000);
  return wiki;
}

function buildPrompt(action, wiki, options) {
  const shared = `Use only the IQ.wiki article below. Never invent facts. Return strict JSON only.
Title: ${wiki.title}
URL: ${wiki.url}
Article:
${wiki.rawText}`;
  if (action === 'video_scenario') {
    const duration = [15, 20, 30].includes(Number(options.duration)) ? Number(options.duration) : 20;
    const style = ['documentary', 'cinematic', 'technical', 'social'].includes(options.style)
      ? options.style : 'documentary';
    return `${shared}
Create a grounded ${duration}-second ${style} vertical video production plan.
Return {"hooks":["five short hooks"],"voiceover":"complete narration","scenes":[{"time":"0-3s","visual":"specific topic-related visual direction","caption":"max five words","voiceover":"scene narration","source_fact":"exact article fact"}],"cta":"short IQ.wiki CTA"}.
Visuals must depict article entities, products, events, places, timelines, metrics, or processes. No random abstract graphics.`;
  }
  if (action === 'funding_timeline') {
    return `${shared}\nReturn {"summary":"short summary","events":[{"date":"date or unknown","event":"fact","amount":"amount or not found","source_fact":"article fact"}]}.`;
  }
  return `${shared}\nReturn {"title":"story title","chapters":[{"heading":"short heading","body":"grounded story section","source_fact":"article fact"}],"cta":"short IQ.wiki CTA"}.`;
}

async function callOpenRouter(prompt, host, model) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': `https://${host || 'iq.wiki'}`,
      'X-Title': 'IQ.wiki Video Studio'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.4
    }),
    signal: AbortSignal.timeout(25000)
  }).catch((error) => {
    if (error.name === 'TimeoutError') throw new AppError(504, 'FREE_MODEL_TIMEOUT', 'The free model timed out.', true);
    throw new AppError(503, 'FREE_MODEL_UNAVAILABLE', 'The free model is unavailable.', true);
  });
  if (!response.ok) {
    const code = response.status === 429 ? 'FREE_MODEL_QUOTA' : 'FREE_MODEL_UNAVAILABLE';
    const message = response.status === 429
      ? 'The free model quota is currently exhausted. Try again later.'
      : 'No approved free model is currently available.';
    throw new AppError(response.status === 429 ? 429 : 503, code, message, true);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new AppError(
      502,
      'INVALID_MODEL_RESPONSE',
      'The free model returned unreadable data. Try again.',
      true
    );
  }
  return parseStrictJson(extractModelContent(data));
}

function enforceRateLimit(result) {
  if (!result.allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);
}

function getClientId(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
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
