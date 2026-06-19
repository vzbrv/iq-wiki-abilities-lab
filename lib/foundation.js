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
    if (this.items.size >= this.maxEntries) {
      this.items.delete(this.items.keys().next().value);
    }
    this.items.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

export function createRateLimiter({ limit, windowMs }) {
  const clients = new Map();
  return (key) => {
    const now = Date.now();
    const current = clients.get(key);
    if (!current || current.resetAt <= now) {
      clients.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
    }
    current.count += 1;
    return {
      allowed: current.count <= limit,
      remaining: Math.max(0, limit - current.count),
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
  if (url.protocol !== 'https:' || (host !== 'iq.wiki' && !host.endsWith('.iq.wiki'))) {
    throw new AppError(400, 'INVALID_WIKI_URL', 'Only HTTPS IQ.wiki URLs are allowed.');
  }
  if (url.username || url.password || url.port || !url.pathname.startsWith('/wiki/')) {
    throw new AppError(400, 'INVALID_WIKI_URL', 'Use a direct IQ.wiki article URL.');
  }
  url.hash = '';
  return url.toString();
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
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanText((titleMatch?.[1] || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s*[-|]\s*IQ\.wiki.*$/i, '');
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  const main = stripped.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || stripped.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || stripped;
  const rawText = cleanText(main
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .slice(0, maxChars);
  return { title, rawText };
}

export function parseStrictJson(value) {
  const cleaned = value.trim().replace(/^```json\s*|\s*```$/g, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AppError(502, 'INVALID_MODEL_RESPONSE', 'The free model returned invalid data. Try again.', true);
  }
}
