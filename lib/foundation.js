export class AppError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class TTLCache {
  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
    this.items = new Map();
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key, value, ttlMs) {
    this.items.delete(key);
    if (this.items.size >= this.maxEntries) {
      this.items.delete(this.items.keys().next().value);
    }
    this.items.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

export function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createRateLimiter({ limit, windowMs, maxEntries = 10_000 }) {
  const safeLimit = readPositiveInteger(limit, 1);
  const safeWindowMs = readPositiveInteger(windowMs, 60_000);
  const safeMaxEntries = readPositiveInteger(maxEntries, 10_000);
  const clients = new Map();
  return (key) => {
    const now = Date.now();
    if (clients.size >= safeMaxEntries && !clients.has(key)) {
      for (const [clientKey, entry] of clients) {
        if (entry.resetAt <= now) clients.delete(clientKey);
      }
      if (clients.size >= safeMaxEntries) clients.delete(clients.keys().next().value);
    }
    const current = clients.get(key);
    if (!current || current.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + safeWindowMs });
      return { allowed: true, remaining: safeLimit - 1, resetAt: now + safeWindowMs };
    }
    current.count += 1;
    return {
      allowed: current.count <= safeLimit,
      remaining: Math.max(0, safeLimit - current.count),
      resetAt: current.resetAt
    };
  };
}

export function assertIqWikiUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'INVALID_WIKI_URL', 'Enter a valid IQ.wiki article URL.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || host !== 'iq.wiki') {
    throw new AppError(400, 'INVALID_WIKI_URL', 'Only HTTPS IQ.wiki URLs are allowed.');
  }
  const isArticlePath = /^\/(?:[a-z]{2}\/)?wiki\/[^/]+\/?$/i.test(url.pathname);
  if (url.username || url.password || url.port || !isArticlePath) {
    throw new AppError(400, 'INVALID_WIKI_URL', 'Use a direct IQ.wiki article URL.');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function readJsonBody(req, maxBytes = 65536) {
  const tooLarge = () => new AppError(413, 'REQUEST_TOO_LARGE', 'Request is too large.');
  const invalid = () => new AppError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  let bytes;

  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      if (Array.isArray(req.body)) throw invalid();
      try {
        bytes = Buffer.from(JSON.stringify(req.body));
      } catch {
        throw invalid();
      }
      if (bytes.length > maxBytes) throw tooLarge();
      return req.body;
    }
    bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
    bytes = Buffer.concat(chunks);
  }

  if (bytes.length > maxBytes) throw tooLarge();
  try {
    const parsed = JSON.parse(bytes.toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
}

export function getOpenRouterReferer(env = process.env) {
  const configured = env.PUBLIC_APP_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  if (!configured) return 'https://iq.wiki';
  try {
    const url = new URL(configured.includes('://') ? configured : `https://${configured}`);
    if (url.protocol !== 'https:' || url.username || url.password) return 'https://iq.wiki';
    return url.origin;
  } catch {
    return 'https://iq.wiki';
  }
}

export function assertFreeModel(model) {
  if (model !== 'openrouter/free' && !model.endsWith(':free')) {
    throw new AppError(
      503,
      'FREE_MODEL_CONFIGURATION_ERROR',
      'The configured OpenRouter model is not free. Generation was blocked.'
    );
  }
  return model;
}

export function getFreeModelCandidates(configured, defaults = []) {
  const configuredModels = String(configured || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const models = [...configuredModels, ...defaults];
  if (!models.length) {
    throw new AppError(503, 'FREE_MODEL_CONFIGURATION_ERROR', 'No free OpenRouter model is configured.');
  }
  const uniqueModels = [...new Set(models.map(assertFreeModel))];
  const routerModel = 'openrouter/free';
  return uniqueModels.includes(routerModel)
    ? [routerModel, ...uniqueModels.filter((model) => model !== routerModel)]
    : uniqueModels;
}

export function cleanText(value = '') {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractWikiText(html, maxChars = 28000) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = cleanText((titleMatch?.[1] || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s*-\s*Cryptoassets\s*\|\s*IQ\.wiki.*$/i, '')
    .replace(/\s*[-|]\s*IQ\.wiki.*$/i, '');
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  const toText = (value) => cleanText(value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
  const regions = [...stripped.matchAll(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map((match) => toText(match[2]));
  const rawText = (regions.sort((a, b) => b.length - a.length)[0] || toText(stripped))
    .slice(0, maxChars);
  return { title, rawText };
}

export function parseStrictJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') {
    throw new AppError(502, 'INVALID_MODEL_RESPONSE', 'The free model returned invalid data. Try again.', true);
  }

  const cleaned = value.replace(/^\uFEFF/, '').trim();
  const candidates = [
    cleaned,
    ...[...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim()),
    ...extractJsonObjects(cleaned)
  ];
  for (const candidate of [...new Set(candidates)]) {
    const parsed = tryParseObject(candidate) || tryParseObject(removeTrailingCommas(candidate));
    if (parsed) return parsed;
  }
  throw new AppError(502, 'INVALID_MODEL_RESPONSE', 'The free model returned invalid data. Try again.', true);
}

export function extractModelContent(data) {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string' || (content && typeof content === 'object' && !Array.isArray(content))) {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => typeof part === 'string' ? part : part?.text || part?.content || '')
      .filter((part) => typeof part === 'string')
      .join('');
    if (text) return text;
  }
  throw new AppError(502, 'EMPTY_MODEL_RESPONSE', 'The free model returned no usable content.', true);
}

function tryParseObject(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return tryParseObject(parsed);
  } catch {
    return null;
  }
  return null;
}

function extractJsonObjects(value) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function removeTrailingCommas(value) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (/\s/.test(value[next] || '')) next += 1;
      if (value[next] === '}' || value[next] === ']') continue;
    }
    output += char;
  }
  return output;
}
