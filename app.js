const params = new URLSearchParams(window.location.search);
const apiBase = params.get('api')?.replace(/\/$/, '') || '';
const form = document.querySelector('#studioForm');
const outputPanel = document.querySelector('#outputPanel');
const emptyState = document.querySelector('#emptyState');
const statusBox = document.querySelector('#status');
const result = document.querySelector('#result');
const submitButton = document.querySelector('#generatePlanBtn');

if (params.get('embed') === '1') document.body.classList.add('embedded');

document.querySelectorAll('.sample').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('#wikiUrl').value = button.dataset.url;
    document.querySelector('#wikiUrl').focus();
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setLoading(true);
  showStatus('Loading the IQ.wiki article and asking a free AI model…', 'loading');

  try {
    const response = await fetch(`${apiBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'video_scenario',
        url: form.wikiUrl.value.trim(),
        options: {
          duration: Number(new FormData(form).get('duration')),
          style: form.style.value
        }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new StudioError(data.code, data.error, data.requestId);
    renderResult(data);
  } catch (error) {
    showStatus(errorMessage(error), 'error');
  } finally {
    setLoading(false);
  }
});

function renderResult(data) {
  const plan = data.result || {};
  const article = data.article || {};
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
  form.querySelectorAll('input, select, .sample').forEach((control) => {
    control.disabled = loading;
  });
}

function showStatus(message, type) {
  emptyState.hidden = true;
  result.hidden = true;
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
    WIKI_TIMEOUT: 'IQ.wiki took too long to respond. Try again.',
    WIKI_UNAVAILABLE: 'That IQ.wiki article could not be loaded.',
    INVALID_WIKI_URL: 'Enter a direct IQ.wiki article URL, such as https://iq.wiki/wiki/solana.',
    WIKI_TEXT_MISSING: 'The article did not contain enough readable text to create a video plan.',
    CONFIGURATION_ERROR: 'Free AI generation is temporarily unavailable.'
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
