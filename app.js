const MAX_API_RESPONSE_BYTES = 1_000_000;
const PLAYBACK_RETRY_DELAY_MS = 30_000;
const MAX_PLAYBACK_RETRY_ENTRIES = 100;
const params = new URLSearchParams(window.location.search);
const configuredApiBase = document.querySelector('meta[name="iq-api-base"]')?.content
  || window.__IQ_WIKI_API_BASE__
  || '';
const apiBase = resolveApiBase(params.get('api'), configuredApiBase);
const form = document.querySelector('#studioForm');
const outputPanel = document.querySelector('#outputPanel');
const emptyState = document.querySelector('#emptyState');
const statusBox = document.querySelector('#status');
const result = document.querySelector('#result');
const videoResult = document.querySelector('#videoResult');
const videoPlayer = document.querySelector('#videoPlayer');
const submitButton = document.querySelector('#generatePlanBtn');
const playbackRetryAfter = new Map();

if (params.get('embed') === '1') document.body.classList.add('embedded');
if (params.get('url')) document.querySelector('#wikiUrl').value = params.get('url');

function normalizeApiBase(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) return '';
    if (url.username || url.password || url.search || url.hash) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

function resolveApiBase(requestedValue, configuredValue) {
  const requested = normalizeApiBase(requestedValue);
  const configured = normalizeApiBase(configuredValue);
  if (!requested) return configured;
  if (requested === configured) return requested;

  const localHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const pageIsLocal = localHosts.includes(window.location.hostname);
  const requestedIsLocal = localHosts.includes(new URL(requested).hostname);
  return pageIsLocal && requestedIsLocal ? requested : configured;
}

function canAttemptPlayback(url) {
  const retryAfter = playbackRetryAfter.get(url);
  if (!retryAfter) return true;
  if (retryAfter > Date.now()) return false;
  playbackRetryAfter.delete(url);
  return true;
}

function rememberPlaybackFailure(url) {
  playbackRetryAfter.delete(url);
  while (playbackRetryAfter.size >= MAX_PLAYBACK_RETRY_ENTRIES) {
    playbackRetryAfter.delete(playbackRetryAfter.keys().next().value);
  }
  playbackRetryAfter.set(url, Date.now() + PLAYBACK_RETRY_DELAY_MS);
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

document.querySelectorAll('.sample').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('#wikiUrl').value = button.dataset.url;
    document.querySelector('#wikiUrl').focus();
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  resetVideoPlayer();
  setLoading(true);
  showStatus('Checking for a ready 15-second explainer…', 'loading');

  try {
    const url = form.wikiUrl.value.trim();
    const stored = await lookupStoredVideo(url);
    if (
      stored?.state === 'ready'
      && stored.asset?.playbackUrl
      && canAttemptPlayback(stored.asset.playbackUrl)
    ) {
      if (await renderStoredVideo(stored)) return;
    }

    await generatePlan(url);
  } catch (error) {
    if (error?.name === 'AbortError') {
      error = new StudioError('REQUEST_TIMEOUT', 'The request took too long.');
    }
    showStatus(errorMessage(error), 'error');
  } finally {
    setLoading(false);
  }
});

async function generatePlan(url) {
  showStatus('No current video is stored yet. Creating its free AI production plan…', 'loading');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 70000);
  let response;
  let data;
  try {
    response = await fetch(`${apiBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'video_scenario',
        url
      }),
      signal: controller.signal
    });
    data = await readResponseData(response);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new StudioError(data.code, data.error, data.requestId);
  renderResult(data);
}

async function lookupStoredVideo(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${apiBase}/api/video?action=lookup&url=${encodeURIComponent(url)}`, {
      signal: controller.signal
    });
    const data = await readResponseData(response);
    if (response.ok) return data.video;
    if (data.code === 'VIDEO_LIBRARY_NOT_CONFIGURED') {
      return { state: 'missing', article: { url } };
    }
    if (data.code === 'INVALID_WIKI_URL') {
      throw new StudioError(data.code, data.error, data.requestId);
    }
    return { state: 'missing', article: { url } };
  } catch (error) {
    if (error instanceof StudioError && error.code === 'INVALID_WIKI_URL') throw error;
    return { state: 'missing', article: { url } };
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseData(response) {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_API_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new StudioError('API_RESPONSE_TOO_LARGE', 'The server returned too much data.');
  }

  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_API_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new StudioError('API_RESPONSE_TOO_LARGE', 'The server returned too much data.');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_API_RESPONSE_BYTES) {
      throw new StudioError('API_RESPONSE_TOO_LARGE', 'The server returned too much data.');
    }
  }

  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    if (response.ok) {
      throw new StudioError('INVALID_API_RESPONSE', 'The server returned an invalid response.');
    }
    parsed = {};
  }
  if (response.ok && !text) {
    throw new StudioError('INVALID_API_RESPONSE', 'The server returned an empty response.');
  }
  if (response.ok && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new StudioError('INVALID_API_RESPONSE', 'The server returned an invalid response.');
  }
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  data.requestId ||= response.headers.get('X-Request-Id') || undefined;
  return data;
}

function resetVideoPlayer() {
  videoPlayer.pause();
  videoPlayer.onerror = null;
  videoPlayer.removeAttribute('src');
  videoPlayer.removeAttribute('poster');
  videoPlayer.load();
}

function renderStoredVideo(video) {
  const asset = video.asset;
  resetVideoPlayer();
  document.querySelector('#videoTitle').textContent = video.article?.title || 'IQ.wiki explainer';
  document.querySelector('#videoArticleLink').href = video.article?.url || form.wikiUrl.value;
  document.querySelector('#videoProvider').textContent = [asset.provider, asset.model].filter(Boolean).join(' · ') || 'AI-generated video';
  videoResult.hidden = true;
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      videoPlayer.removeEventListener('loadedmetadata', handleReady);
      videoPlayer.removeEventListener('error', handleError);
      if (!ready) {
        rememberPlaybackFailure(asset.playbackUrl);
        resetVideoPlayer();
      } else {
        playbackRetryAfter.delete(asset.playbackUrl);
        emptyState.hidden = true;
        statusBox.hidden = true;
        result.hidden = true;
        videoResult.hidden = false;
        outputPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        videoPlayer.play().catch(() => {});
      }
      resolve(ready);
    };
    const handleReady = () => finish(true);
    const handleError = () => finish(false);
    videoPlayer.addEventListener('loadedmetadata', handleReady, { once: true });
    videoPlayer.addEventListener('error', handleError, { once: true });
    timeout = setTimeout(() => finish(false), 8000);
    if (asset.posterUrl) {
      videoPlayer.poster = asset.posterUrl;
    } else {
      videoPlayer.removeAttribute('poster');
    }
    videoPlayer.src = asset.playbackUrl;
    videoPlayer.load();
    if (videoPlayer.readyState >= 1) queueMicrotask(handleReady);
  });
}

function renderResult(data) {
  const plan = data.result || {};
  const article = data.article || {};
  if (!Array.isArray(plan.hooks) || !Array.isArray(plan.scenes) || !plan.voiceover) {
    throw new StudioError('INVALID_MODEL_RESPONSE', 'The free AI model returned an incomplete answer.');
  }
  document.querySelector('#articleTitle').textContent = article.title || 'IQ.wiki article';
  document.querySelector('#articleLink').href = article.url || form.wikiUrl.value;
  document.querySelector('#articleSummary').textContent = article.summary || '';
  document.querySelector('#modelBadge').textContent = `Free AI · ${data.model || 'OpenRouter'}`;
  document.querySelector('#voiceover').textContent = plan.voiceover || 'No narration was returned.';

  const hooks = document.querySelector('#hooks');
  hooks.replaceChildren(...(plan.hooks || []).map((hook) => element('span', 'hook', hook)));

  const scenes = document.querySelector('#scenes');
  scenes.replaceChildren(...(plan.scenes || []).map((scene, index) => {
    const item = element('article', 'scene');
    const heading = element('div', 'scene-heading');
    heading.append(
      element('span', 'scene-number', String(index + 1)),
      element('strong', '', scene.time || `Scene ${index + 1}`)
    );
    item.append(
      heading,
      labelledText('Visual', scene.visual),
      labelledText('Narration', scene.voiceover),
      labelledText('On screen', scene.caption),
      labelledText('Source fact', scene.source_fact, 'source-fact')
    );
    return item;
  }));

  emptyState.hidden = true;
  statusBox.hidden = true;
  videoResult.hidden = true;
  result.hidden = false;
  outputPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function labelledText(label, value, className = '') {
  const row = element('p', `scene-row ${className}`.trim());
  row.append(element('span', '', `${label}:`), document.createTextNode(` ${value || 'Not provided'}`));
  return row;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.classList.toggle('is-loading', loading);
  outputPanel.setAttribute('aria-busy', String(loading));
  form.querySelectorAll('input, .sample').forEach((control) => {
    control.disabled = loading;
  });
}

function showStatus(message, type) {
  emptyState.hidden = true;
  result.hidden = true;
  videoResult.hidden = true;
  statusBox.hidden = false;
  statusBox.className = `message ${type}`;
  statusBox.textContent = message;
}

function errorMessage(error) {
  const messages = {
    RATE_LIMITED: 'This studio has reached its request limit. Try again later.',
    FREE_MODEL_QUOTA: 'Free AI capacity is full right now. No paid model was used. Try again later.',
    FREE_MODEL_UNAVAILABLE: 'No approved free AI model is available right now. No paid fallback was used.',
    FREE_MODEL_TIMEOUT: 'The free AI model took too long to respond. Try again.',
    FREE_MODELS_EXHAUSTED: 'Free AI capacity is full right now. No paid model was used. Try again later.',
    FREE_MODELS_UNAVAILABLE: 'Free AI models could not complete this request. No paid model was used. Try again.',
    EMPTY_MODEL_RESPONSE: 'The free AI model returned no usable answer. No paid fallback was used. Try again.',
    INVALID_MODEL_RESPONSE: 'The free AI model returned an unusable answer. No paid fallback was used. Try again.',
    REQUEST_TIMEOUT: 'Generation took too long. No paid fallback was used. Try again.',
    API_RESPONSE_TOO_LARGE: 'The server response was too large. Try again.',
    INVALID_API_RESPONSE: 'The server returned an invalid response. Try again.',
    WIKI_TIMEOUT: 'IQ.wiki took too long to respond. Try again.',
    WIKI_UNAVAILABLE: 'That IQ.wiki article could not be loaded.',
    INVALID_WIKI_URL: 'Enter a direct IQ.wiki article URL, such as https://iq.wiki/wiki/solana.',
    WIKI_TEXT_MISSING: 'The article did not contain enough readable text to create a video plan.',
    CONFIGURATION_ERROR: 'Free AI generation is temporarily unavailable.',
    VIDEO_LIBRARY_UNAVAILABLE: 'The explainer video library is temporarily unavailable. Try again later.',
    VIDEO_LIBRARY_NOT_CONFIGURED: 'The explainer video library is temporarily unavailable. Try again later.',
    VIDEO_LIBRARY_CONFIGURATION_ERROR: 'The explainer video library is temporarily unavailable. Try again later.'
  };
  const message = messages[error.code] || error.message || 'The request failed. Try again.';
  return error.requestId ? `${message} Reference: ${error.requestId.slice(0, 8)}` : message;
}

class StudioError extends Error {
  constructor(code, message, requestId) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}
