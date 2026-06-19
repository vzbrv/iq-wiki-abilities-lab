import { randomUUID } from 'node:crypto';
import {
  AppError,
  TTLCache,
  assertIqWikiUrl,
  createRateLimiter,
  extractModelContent,
  extractWikiText,
  getFreeModelCandidates,
  parseStrictJson
} from '../lib/foundation.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_FREE_MODELS = [
  'openrouter/free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-26b-a4b-it:free'
];
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
    const models = getConfiguredModels();
    if (!process.env.OPENROUTER_API_KEY) {
      throw new AppError(503, 'CONFIGURATION_ERROR', 'Free AI generation is not configured.');
    }

    const cacheKey = JSON.stringify([action, wiki.url, body.options || {}, models]);
    let generated = resultCache.get(cacheKey);
    if (!generated) {
      generated = await callOpenRouter(buildPrompt(action, wiki, body.options || {}), req.headers.host, models);
      resultCache.set(cacheKey, generated, 900000);
    }
    const { result, model } = generated;

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

function getConfiguredModels() {
  const configured = process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL;
  const defaults = process.env.OPENROUTER_MODELS ? [] : DEFAULT_FREE_MODELS;
  return getFreeModelCandidates(configured, defaults);
}

export async function callOpenRouter(prompt, host, models, request = requestOpenRouter) {
  let lastError;
  const deadline = Date.now() + 45000;
  for (const model of models) {
    const timeoutMs = Math.min(18000, deadline - Date.now());
    if (timeoutMs < 1000) break;
    try {
      return { result: await request(prompt, host, model, timeoutMs), model };
    } catch (error) {
      if (!isFreeModelFailure(error)) throw error;
      lastError = error;
      log('free_model_failed', { model, code: error.code, status: error.status });
    }
  }
  throw new AppError(
    lastError?.status === 429 ? 429 : 503,
    'FREE_MODELS_EXHAUSTED',
    'Free AI capacity is full right now. No paid model was used. Try again later.',
    true
  );
}

function isFreeModelFailure(error) {
  return [
    'FREE_MODEL_QUOTA',
    'FREE_MODEL_TIMEOUT',
    'FREE_MODEL_UNAVAILABLE',
    'INVALID_MODEL_RESPONSE',
    'EMPTY_MODEL_RESPONSE'
  ].includes(error.code);
}

async function requestOpenRouter(prompt, host, model, timeoutMs) {
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
      messages: [
        {
          role: 'system',
          content: 'Return one complete JSON object only. Do not use Markdown or add explanatory text.'
        },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1800
    }),
    signal: AbortSignal.timeout(timeoutMs)
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
