import { createHash } from 'node:crypto';
import { AppError, assertIqWikiUrl } from '../foundation.js';

const WORD_DELTA_THRESHOLD = 0.2;
const SIMILARITY_THRESHOLD = 0.9;
const SHINGLE_SIZE = 5;
const MAX_SIGNATURE_SIZE = 128;

export function createArticleSnapshot(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'INVALID_ARTICLE', 'A title and readable article text are required.');
  }
  const { title, url, rawText } = input;
  const canonicalUrl = assertIqWikiUrl(url);
  const normalizedTitle = normalizeText(title);
  const normalizedText = normalizeText(rawText);
  if (!normalizedTitle || normalizedText.length < 200) {
    throw new AppError(400, 'INVALID_ARTICLE', 'A title and readable article text are required.');
  }

  const words = normalizedText.split(' ');
  return {
    url: canonicalUrl,
    title: String(title).trim().slice(0, 200),
    normalizedTitle,
    exactHash: hash(`${normalizedTitle}\n${normalizedText}`),
    wordCount: words.length,
    facts: extractFacts(normalizedText),
    signature: createSignature(words)
  };
}

export function classifyArticleChange(previous, next) {
  if (!previous) return change(true, 'new_article', 0);
  if (previous.exactHash === next.exactHash) return change(false, 'unchanged', 1);
  if (previous.normalizedTitle !== next.normalizedTitle) return change(true, 'title_changed', 0);
  if (!sameArray(previous.facts, next.facts)) return change(true, 'facts_changed', 0);

  const wordDelta = Math.abs(previous.wordCount - next.wordCount) / Math.max(previous.wordCount, 1);
  if (wordDelta >= WORD_DELTA_THRESHOLD) return change(true, 'length_changed', 1 - wordDelta);

  const similarity = jaccard(previous.signature, next.signature);
  if (similarity < SIMILARITY_THRESHOLD) return change(true, 'content_rewritten', similarity);
  return change(false, 'minor_edit', similarity);
}

export class MemoryVideoLibraryStore {
  constructor() {
    this.records = new Map();
  }

  async get(key) {
    return this.records.get(key) || null;
  }

  async set(key, value) {
    this.records.set(key, value);
  }

  async getVersioned(key) {
    const value = this.records.get(key) || null;
    return { raw: value ? JSON.stringify(value) : null, value };
  }

  async compareAndSet(key, expectedRaw, value) {
    const current = this.records.get(key) || null;
    if ((current ? JSON.stringify(current) : null) !== expectedRaw) return false;
    this.records.set(key, value);
    return true;
  }
}

export class RestVideoLibraryStore {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = normalizeLibraryUrl(url);
    this.token = String(token || '').trim();
    if (!this.token) {
      throw new AppError(503, 'VIDEO_LIBRARY_CONFIGURATION_ERROR', 'Video library storage configuration is invalid.');
    }
    this.fetchImpl = fetchImpl;
  }

  async get(key) {
    const value = await this.command(['GET', key]);
    return parseStoredRecord(value);
  }

  async set(key, value) {
    await this.command(['SET', key, JSON.stringify(value)]);
  }

  async getVersioned(key) {
    const raw = await this.command(['GET', key]);
    return { raw, value: parseStoredRecord(raw) };
  }

  async compareAndSet(key, expectedRaw, value) {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if ((not current and ARGV[1] == '__MISSING__') or current == ARGV[1]) then
        redis.call('SET', KEYS[1], ARGV[2])
        return 1
      end
      return 0
    `;
    const result = await this.command([
      'EVAL',
      script,
      '1',
      key,
      expectedRaw ?? '__MISSING__',
      JSON.stringify(value)
    ]);
    return Number(result) === 1;
  }

  async command(command) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(command),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      return data.result;
    } catch {
      throw new AppError(503, 'VIDEO_LIBRARY_UNAVAILABLE', 'The video library is temporarily unavailable.', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

class UnconfiguredVideoLibraryStore {
  async get() {
    return null;
  }

  async set() {
    throw new AppError(503, 'VIDEO_LIBRARY_NOT_CONFIGURED', 'The production video library is not configured.');
  }

  async getVersioned() {
    throw new AppError(503, 'VIDEO_LIBRARY_NOT_CONFIGURED', 'The production video library is not configured.');
  }

  async compareAndSet() {
    throw new AppError(503, 'VIDEO_LIBRARY_NOT_CONFIGURED', 'The production video library is not configured.');
  }
}

export function createVideoLibraryStore(env = process.env) {
  const url = String(env.VIDEO_LIBRARY_REST_URL || '').trim();
  const token = String(env.VIDEO_LIBRARY_REST_TOKEN || '').trim();
  if (Boolean(url) !== Boolean(token)) {
    throw new AppError(503, 'VIDEO_LIBRARY_CONFIGURATION_ERROR', 'Video library storage is incomplete.');
  }
  if (url) return new RestVideoLibraryStore({ url, token });
  if (env.NODE_ENV === 'production') return new UnconfiguredVideoLibraryStore();
  return new MemoryVideoLibraryStore();
}

function normalizeLibraryUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new AppError(503, 'VIDEO_LIBRARY_CONFIGURATION_ERROR', 'Video library storage configuration is invalid.');
  }
}

export class VideoLibraryService {
  constructor(store) {
    this.store = store;
  }

  async lookup(rawUrl) {
    const url = assertIqWikiUrl(rawUrl);
    const record = await this.store.get(keyFor(url));
    if (!record) return { state: 'missing', article: { url } };
    return publicRecord(record);
  }

  async syncArticle(article) {
    const snapshot = createArticleSnapshot(article);
    const key = keyFor(snapshot.url);
    let articleChange;
    const record = await mutateRecord(this.store, key, (previous) => {
      const latestChange = classifyArticleChange(previous?.snapshot, snapshot);
      const materialBaseline = previous?.materialSnapshot || previous?.snapshot;
      articleChange =
        latestChange.reason === 'unchanged'
          ? latestChange
          : classifyArticleChange(materialBaseline, snapshot);
      const now = new Date().toISOString();
      const materialRevision = articleChange.material
        ? snapshot.exactHash
        : previous?.materialRevision || snapshot.exactHash;
      return {
        article: { title: snapshot.title, url: snapshot.url },
        snapshot,
        materialSnapshot: articleChange.material
          ? snapshot
          : previous?.materialSnapshot || previous?.snapshot || snapshot,
        materialRevision,
        state: articleChange.material ? 'needs_generation' : previous?.state || 'needs_generation',
        asset: articleChange.material ? null : previous?.asset || null,
        createdAt: previous?.createdAt || now,
        updatedAt: now
      };
    });
    return { ...publicRecord(record), change: articleChange };
  }

  async publishAsset(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AppError(400, 'INVALID_VIDEO_ASSET', 'A valid video asset is required.');
    }
    const url = assertIqWikiUrl(input.url);
    const key = keyFor(url);
    const playbackUrl = assertAssetUrl(input.playbackUrl, 'playbackUrl');
    const posterUrl = input.posterUrl ? assertAssetUrl(input.posterUrl, 'posterUrl') : null;
    const record = await mutateRecord(this.store, key, (previous) => {
      if (!previous) throw new AppError(404, 'VIDEO_REVISION_NOT_FOUND', 'Sync the article before publishing its video.');
      if (input.revision !== previous.materialRevision) {
        throw new AppError(409, 'STALE_VIDEO_REVISION', 'The article changed while this video was rendering.');
      }
      const publishedAt = new Date().toISOString();
      return {
        ...previous,
        state: 'ready',
        asset: {
          revision: previous.materialRevision,
          playbackUrl,
          posterUrl,
          provider: bounded(input.provider, 80),
          model: bounded(input.model, 120),
          durationSeconds: 15,
          publishedAt
        },
        updatedAt: publishedAt
      };
    });
    return publicRecord(record);
  }
}

async function mutateRecord(store, key, update) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await store.getVersioned(key);
    const next = update(current.value);
    if (await store.compareAndSet(key, current.raw, next)) return next;
  }
  throw new AppError(409, 'VIDEO_LIBRARY_CONFLICT', 'The article changed during this update. Try again.', true);
}

function parseStoredRecord(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new AppError(503, 'VIDEO_LIBRARY_UNAVAILABLE', 'The video library is temporarily unavailable.', true);
  }
}

function publicRecord(record) {
  const assetIsCurrent = record.asset?.revision === record.materialRevision;
  return {
    state: record.state === 'ready' && assetIsCurrent ? 'ready' : 'needs_generation',
    article: record.article,
    revision: record.materialRevision,
    asset: assetIsCurrent ? record.asset : null,
    updatedAt: record.updatedAt
  };
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$€£.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFacts(text) {
  const matches = text.match(/0x[a-f0-9]{40}|[$€£]?\d[\d,.]*(?:%|[a-z]{2,4})?/gi) || [];
  return [...new Set(matches.map((value) => value.toLowerCase()))].sort();
}

function createSignature(words) {
  const shingles = [];
  for (let index = 0; index <= words.length - SHINGLE_SIZE; index += 1) {
    shingles.push(hash(words.slice(index, index + SHINGLE_SIZE).join(' ')).slice(0, 16));
  }
  return [...new Set(shingles)].sort().slice(0, MAX_SIGNATURE_SIZE);
}

function jaccard(left = [], right = []) {
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((value) => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 1;
}

function change(material, reason, similarity) {
  return { material, reason, similarity: Math.max(0, Number(similarity.toFixed(3))) };
}

function sameArray(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function keyFor(url) {
  return `iqwiki:video:v1:${hash(url)}`;
}

function assertAssetUrl(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new AppError(400, 'INVALID_VIDEO_ASSET', `${field} must be a public HTTPS URL.`);
  }
}

function bounded(value, maxLength) {
  return value ? String(value).trim().slice(0, maxLength) : null;
}
