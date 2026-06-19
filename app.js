const API_BASE_STORAGE_KEY = 'iqAbilitiesApiBase';
const samples = [
  {
    title: 'Nexus',
    subtitle: 'zkVM / verifiable computation project',
    url: 'https://iq.wiki/wiki/nexus'
  },
  {
    title: 'Terra',
    subtitle: 'algorithmic stablecoin lore',
    url: 'https://iq.wiki/wiki/terra'
  },
  {
    title: 'Do Kwon',
    subtitle: 'founder page with collapse/legal context',
    url: 'https://iq.wiki/wiki/do-kwon'
  },
  {
    title: 'Daniel Marin',
    subtitle: 'founder profile',
    url: 'https://iq.wiki/wiki/daniel-marin'
  },
  {
    title: 'Solana',
    subtitle: 'high-throughput L1',
    url: 'https://iq.wiki/wiki/solana'
  },
  {
    title: 'Bittensor',
    subtitle: 'AI/crypto network',
    url: 'https://iq.wiki/wiki/bittensor'
  }
];

const abilityCopy = {
  short: {
    label: 'Short Video Studio',
    title: 'Generate a 15–30 second video scenario from this wiki',
    action: 'video_scenario'
  },
  funding: {
    label: 'Funding & Token Sale Timeline',
    title: 'Extract funding/token-sale facts from the wiki, with placeholders where missing',
    action: 'funding_timeline'
  },
  lore: {
    label: 'Crypto Lore',
    title: 'Turn this wiki into a scrollable story/lore module',
    action: 'crypto_lore'
  }
};

let state = {
  wiki: null,
  activeTab: 'short',
  widgetMode: false,
  outputs: {}
};
let shortPlayback = { frame: 0 };

const $ = (id) => document.getElementById(id);
const loader = $('loader');
const workspace = $('workspace');
const output = $('output');
const status = $('status');

function init() {
  renderSamples();
  attachEvents();
}

function renderSamples() {
  $('sampleGrid').innerHTML = samples.map((sample, index) => `
    <button class="sample-card" data-sample-index="${index}">
      <strong>${escapeHtml(sample.title)}</strong>
      <small>${escapeHtml(sample.subtitle)}</small>
    </button>
  `).join('');
}

function attachEvents() {

  const savedEndpoint = localStorage.getItem(API_BASE_STORAGE_KEY) || '';
  if ($('apiEndpoint')) $('apiEndpoint').value = savedEndpoint;
  $('saveEndpointBtn').addEventListener('click', () => {
    const value = $('apiEndpoint').value.trim().replace(/\/$/, '');
    localStorage.setItem(API_BASE_STORAGE_KEY, value);
    showStatus(value ? `API endpoint saved: ${value}` : 'Using same-origin API endpoint.');
    setTimeout(() => hideStatus(), 1500);
  });

  $('loadUrlBtn').addEventListener('click', async () => {
    const url = $('wikiUrl').value.trim();
    if (!url) return showStatus('Paste an IQ.wiki URL first.', true);
    await loadWiki({ url });
  });

  $('sampleGrid').addEventListener('click', async (event) => {
    const card = event.target.closest('[data-sample-index]');
    if (!card) return;
    const sample = samples[Number(card.dataset.sampleIndex)];
    $('wikiUrl').value = sample.url;
    await loadWiki({ url: sample.url });
  });

  $('resetBtn').addEventListener('click', () => {
    stopShortPlayback();
    workspace.classList.add('hidden');
    loader.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      setActiveTab(tab.dataset.tab);
    });
  });

  $('generateBtn').addEventListener('click', generateCurrentAbility);
  $('widgetToggle').addEventListener('click', () => {
    state.widgetMode = !state.widgetMode;
    $('widgetToggle').setAttribute('aria-pressed', String(state.widgetMode));
    $('widgetToggle').textContent = state.widgetMode ? 'Full app view' : 'Widget preview';
    output.classList.toggle('widget-mode', state.widgetMode);
    renderOutput();
  });

  document.body.addEventListener('click', async (event) => {
    const play = event.target.closest('[data-play-video]');
    if (play) {
      startShortPlayback(true);
      return;
    }

    const copy = event.target.closest('[data-copy]');
    if (copy) {
      const text = decodeURIComponent(copy.dataset.copy);
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
      setTimeout(() => copy.textContent = 'Copy', 900);
    }

    const modal = event.target.closest('[data-open-modal]');
    if (modal) openModal(modal.dataset.openModal);
  });

  $('closeModal').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (event) => {
    if (event.target.id === 'modal') closeModal();
  });
}

function getApiBase() {
  return (localStorage.getItem(API_BASE_STORAGE_KEY) || '').replace(/\/$/, '');
}
function apiUrl() {
  return `${getApiBase()}/api/generate`;
}

async function loadWiki(payload) {
  showStatus('Loading wiki content…');
  setLoading(true);
  try {
    const response = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'load_wiki', ...payload })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load wiki');
    const wiki = data.wiki;

    state.wiki = wiki;
    state.outputs = {};
    loader.classList.add('hidden');
    workspace.classList.remove('hidden');
    setActiveTab('short');
    renderWikiSummary();
    showStatus('Wiki loaded. Choose a tab and generate with AI.');
    setTimeout(() => hideStatus(), 1600);
    window.scrollTo({ top: workspace.offsetTop - 90, behavior: 'smooth' });
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    setLoading(false);
  }
}

function renderWikiSummary() {
  const wiki = state.wiki;
  $('wikiTitle').textContent = wiki.title || 'Loaded wiki';
  $('wikiSource').textContent = wiki.url;
  $('wikiSource').href = wiki.url || '#';
  $('wikiSummaryText').textContent = wiki.summary || wiki.rawText?.slice(0, 260) || 'No summary extracted yet.';
  const badges = [
    wiki.loadMode || 'loaded content',
    'OpenRouter Free scenario',
    'video provider not connected',
    'editor review required',
    'scenario preview'
  ];
  $('wikiBadges').innerHTML = badges.map((badge, idx) => `<span class="badge ${idx === 1 ? 'good' : idx === 2 ? 'warn' : ''}">${escapeHtml(badge)}</span>`).join('');
}

function setActiveTab(tabKey) {
  stopShortPlayback();
  state.activeTab = tabKey;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabKey));
  $('activeAbilityLabel').textContent = abilityCopy[tabKey].label;
  $('activeAbilityTitle').textContent = abilityCopy[tabKey].title;
  $('generateBtn').textContent = tabKey === 'short' ? 'Generate script & scenes' : 'Generate ability';
  renderOutput();
}

async function generateCurrentAbility() {
  if (!state.wiki) return showStatus('Load a wiki first.', true);
  const ability = abilityCopy[state.activeTab];
  output.innerHTML = document.getElementById('loadingTemplate').innerHTML;
  showStatus(`Generating ${ability.label} with AI…`);
  $('generateBtn').disabled = true;

  try {
    const response = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: ability.action, url: state.wiki.url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI generation failed');
    state.outputs[state.activeTab] = {
      ...data.result,
      _delivery: {
        provider: data.provider,
        model: data.model,
        freeOnly: data.freeOnly,
        pipeline: data.pipeline
      }
    };
    renderOutput();
    showStatus(state.activeTab === 'short'
      ? 'Scenario generated with OpenRouter Free. Video provider is not connected.'
      : 'Generated with an approved free OpenRouter model.');
    setTimeout(() => hideStatus(), 1800);
  } catch (error) {
    state.outputs[state.activeTab] = null;
    renderOutput();
    showStatus(error.message, true);
  } finally {
    $('generateBtn').disabled = false;
  }
}

function renderOutput() {
  output.classList.toggle('widget-mode', state.widgetMode);
  const result = state.outputs[state.activeTab];
  if (!result) {
    output.innerHTML = emptyStateForTab(state.activeTab);
    return;
  }
  if (state.activeTab === 'short') return renderShort(result);
  if (state.activeTab === 'funding') return renderFunding(result);
  if (state.activeTab === 'lore') return renderLore(result);
}

function emptyStateForTab(tab) {
  const copy = {
    short: 'Generate a source-backed script and scene plan. AI video rendering is connected separately.',
    funding: 'Generate a structured funding/token sale table using wiki content first. Missing data becomes placeholders.',
    lore: 'Generate a story-style crypto lore page from the loaded wiki.'
  };
  return `<div class="empty-state"><strong>${escapeHtml(abilityCopy[tab].label)}</strong><br>${escapeHtml(copy[tab])}<br><br><button class="secondary-btn" data-open-modal="production-${tab}">How this works in production</button></div>`;
}

function renderShort(data) {
  const hooks = Array.isArray(data.hooks) ? data.hooks : [];
  const scenes = Array.isArray(data.scenes) ? data.scenes : [];
  const delivery = data._delivery || {};
  output.innerHTML = `
    <div class="video-layout">
      <div class="video-player">
        <canvas id="shortVideoCanvas" width="360" height="640" aria-label="Video scenario preview"></canvas>
        <button class="video-play" data-play-video type="button" aria-label="Preview scenario with browser narration">▶</button>
      </div>
      <div class="card">
        <span class="badge good">Scenario: OpenRouter Free</span>
        <span class="badge warn">Video model: not connected</span>
        <h4>15–30 second video scenario</h4>
        <p>${escapeHtml(data.voiceover || '')}</p>
        <p>OpenRouter generated the script and scene plan only. No video model was called.</p>
        <button class="primary-btn" data-play-video type="button">Preview scenario</button>
        <button class="secondary-btn" type="button" disabled title="Connect a separate video provider and API key to enable">Generate AI video</button>
        ${actionButtons(data.voiceover || '')}
      </div>
    </div>
    <div class="card">
        <h4>Hook options</h4>
        <ol>${hooks.map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ol>
        ${actionButtons(hooks.join('\n'))}
    </div>
    <div class="card">
      <h4>Scene-by-scene shot list</h4>
      <div class="timeline">
        ${scenes.map(scene => `
          <div class="timeline-item">
            <div class="timeline-date">${escapeHtml(scene.time || '')}</div>
            <div class="timeline-content">
              <strong>${escapeHtml(scene.visual || scene.scene || 'Scene')}</strong>
              <p>${escapeHtml(scene.caption || scene.voiceover || '')}</p>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div class="grid-two">
      <div class="card"><h4>TikTok caption</h4><p>${escapeHtml(data.tiktok_caption || '')}</p>${actionButtons(data.tiktok_caption || '')}</div>
      <div class="card"><h4>X caption</h4><p>${escapeHtml(data.x_caption || '')}</p>${actionButtons(data.x_caption || '')}</div>
    </div>
    <div class="card"><h4>Suggested visuals</h4><ul>${(data.suggested_visuals || []).map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul></div>
    <div class="card"><h4>Fact-check checklist</h4><ul>${(data.fact_check || []).map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul></div>
  `;
  requestAnimationFrame(() => startShortPlayback(false));
}

function stopShortPlayback() {
  if (shortPlayback.frame) cancelAnimationFrame(shortPlayback.frame);
  shortPlayback.frame = 0;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function startShortPlayback(withNarration = false) {
  const canvas = $('shortVideoCanvas');
  const data = state.outputs.short;
  if (!canvas || !data) return;

  stopShortPlayback();
  const scenes = data.scenes?.length ? data.scenes : [{
    time: '0-15s',
    visual: state.wiki?.title || 'IQ.wiki',
    caption: data.voiceover || ''
  }];
  const finalTime = String(scenes.at(-1)?.time || '').match(/\d+/g) || [];
  const duration = Math.max(15, Math.min(30, Number(finalTime.at(-1)) || scenes.length * 5));
  const context = canvas.getContext('2d');
  const started = performance.now();

  if (withNarration && 'speechSynthesis' in window) {
    const narration = new SpeechSynthesisUtterance(data.voiceover || scenes.map(scene => scene.caption).join('. '));
    narration.rate = 1.08;
    window.speechSynthesis.speak(narration);
  }

  const draw = (now) => {
    const elapsed = Math.min((now - started) / 1000, duration);
    const scene = scenes.find(item => {
      const [start, end] = getSceneWindow(item.time);
      return elapsed >= start && elapsed < end;
    }) || scenes.at(-1);
    drawShortFrame(context, canvas, scene, elapsed, duration);
    if (elapsed < duration) shortPlayback.frame = requestAnimationFrame(draw);
  };
  shortPlayback.frame = requestAnimationFrame(draw);
}

function getSceneWindow(value) {
  const times = String(value || '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  return [times[0] || 0, times[1] || times[0] + 5];
}

function drawShortFrame(context, canvas, scene, elapsed, duration) {
  const progress = elapsed / duration;
  context.fillStyle = '#120f16';
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = 'rgba(255,255,255,.055)';
  context.lineWidth = 1;
  for (let x = 0; x <= canvas.width; x += 40) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height); context.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 40) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke();
  }

  context.fillStyle = '#35e7bb';
  context.font = '700 18px system-ui';
  context.fillText('IQ.wiki', 24, 42);

  drawTopicVisual(context, scene, elapsed);

  context.fillStyle = '#ffffff';
  context.font = '700 20px system-ui';
  context.textAlign = 'center';
  wrapCanvasText(context, shortWords(scene.caption || scene.visual, 5), 180, 545, 300, 26, 2, 'center');
  context.textAlign = 'left';

  context.fillStyle = 'rgba(255,255,255,.25)';
  context.fillRect(24, 596, canvas.width - 48, 6);
  context.fillStyle = '#35e7bb';
  context.fillRect(24, 596, (canvas.width - 48) * progress, 6);
  context.fillStyle = '#ffffff';
  context.font = '600 14px system-ui';
  context.fillText(`${Math.ceil(elapsed)}s / ${duration}s`, 24, 626);
}

function drawTopicVisual(context, scene, elapsed) {
  const data = scene.visual_data || {};
  const type = scene.visual_type || inferVisualType(scene);
  const topic = data.primary || state.wiki?.title || 'IQ.wiki';
  const items = Array.isArray(data.items) ? data.items.slice(0, 4) : [];
  const pulse = 1 + Math.sin(elapsed * 4) * 0.025;

  if (type === 'network' || type === 'person') {
    drawNode(context, 180, 270, topic, 74 * pulse, '#7137d9');
    const points = [[76, 150], [284, 150], [76, 390], [284, 390]];
    (items.length ? items : [{ label: data.secondary || 'Key relationship' }]).forEach((item, index) => {
      const [x, y] = points[index];
      context.strokeStyle = '#35e7bb';
      context.lineWidth = 2;
      context.beginPath(); context.moveTo(180, 270); context.lineTo(x, y); context.stroke();
      drawNode(context, x, y, item.label, 48, '#24202a');
    });
    return;
  }

  if (type === 'timeline' || type === 'event') {
    context.strokeStyle = '#7137d9';
    context.lineWidth = 5;
    context.beginPath(); context.moveTo(62, 120); context.lineTo(62, 465); context.stroke();
    const rows = items.length ? items : [{ label: data.date || topic, detail: data.secondary }];
    rows.forEach((item, index) => {
      const y = 145 + index * Math.min(95, 300 / Math.max(1, rows.length - 1));
      context.fillStyle = '#35e7bb';
      context.beginPath(); context.arc(62, y, 10, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#ffffff';
      context.font = '700 19px system-ui';
      context.fillText(shortWords(item.label, 4), 92, y - 5);
      context.fillStyle = '#bdb5c7';
      context.font = '500 14px system-ui';
      wrapCanvasText(context, shortWords(item.detail, 9), 92, y + 18, 230, 18, 2);
    });
    return;
  }

  if (type === 'metric' || type === 'comparison') {
    context.fillStyle = '#7137d9';
    context.fillRect(30, 125, 300, 300);
    context.fillStyle = '#35e7bb';
    context.font = '800 56px system-ui';
    context.textAlign = 'center';
    wrapCanvasText(context, data.value || topic, 180, 245, 270, 62, 2, 'center');
    context.fillStyle = '#ffffff';
    context.font = '700 20px system-ui';
    wrapCanvasText(context, shortWords(data.secondary, 10), 180, 350, 260, 26, 3, 'center');
    context.textAlign = 'left';
    return;
  }

  if (type === 'process') {
    const rows = items.length ? items : [{ label: topic }, { label: data.secondary }];
    rows.slice(0, 4).forEach((item, index) => {
      const y = 125 + index * 95;
      context.fillStyle = index % 2 ? '#24202a' : '#7137d9';
      context.fillRect(38, y, 284, 66);
      context.fillStyle = '#35e7bb';
      context.font = '800 24px system-ui';
      context.fillText(String(index + 1).padStart(2, '0'), 55, y + 41);
      context.fillStyle = '#ffffff';
      context.font = '700 16px system-ui';
      wrapCanvasText(context, shortWords(item.label || item.detail, 7), 98, y + 28, 205, 20, 2);
    });
    return;
  }

  context.fillStyle = '#7137d9';
  context.beginPath(); context.arc(180, 265, 126 * pulse, 0, Math.PI * 2); context.fill();
  context.fillStyle = '#35e7bb';
  context.font = '800 72px system-ui';
  context.textAlign = 'center';
  context.fillText(String(topic).trim().charAt(0).toUpperCase(), 180, 290);
  context.fillStyle = '#ffffff';
  context.font = '800 27px system-ui';
  wrapCanvasText(context, shortWords(topic, 6), 180, 430, 300, 34, 3, 'center');
  context.textAlign = 'left';
}

function inferVisualType(scene) {
  const value = `${scene.visual || ''} ${scene.source_fact || ''}`.toLowerCase();
  if (/\$|\d+\s?(million|billion)|amount|value/.test(value)) return 'metric';
  if (/\b(19|20)\d{2}\b|timeline|date|launched|founded/.test(value)) return 'timeline';
  if (/connect|network|person|founder|partner/.test(value)) return 'network';
  if (/process|step|works|mechanism/.test(value)) return 'process';
  return 'title';
}

function drawNode(context, x, y, label, radius, color) {
  context.fillStyle = color;
  context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  context.fillStyle = '#ffffff';
  context.font = radius > 60 ? '700 17px system-ui' : '700 13px system-ui';
  context.textAlign = 'center';
  wrapCanvasText(context, shortWords(label, radius > 60 ? 5 : 3), x, y - 5, radius * 1.55, 17, 3, 'center');
  context.textAlign = 'left';
}

function shortWords(value, limit) {
  return String(value || '').trim().split(/\s+/).slice(0, limit).join(' ');
}

function wrapCanvasText(context, text, x, y, maxWidth, lineHeight, maxLines = 4, align = 'left') {
  const words = String(text).split(/\s+/);
  let line = '';
  let row = 0;
  for (const word of words) {
    const test = `${line}${word} `;
    if (context.measureText(test).width > maxWidth && line) {
      context.fillText(line.trim(), x, y + row * lineHeight);
      line = `${word} `;
      row += 1;
      if (row >= maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line && row < maxLines) context.fillText(line.trim(), x, y + row * lineHeight);
}

function renderFunding(data) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const warnings = data.warnings || [];
  output.innerHTML = `
    <div class="grid-three">
      <div class="kpi"><span>Total raised found</span><strong>${escapeHtml(data.total_raised_found || 'Not found')}</strong></div>
      <div class="kpi"><span>Token sale info</span><strong>${escapeHtml(data.token_sale_status || 'Unknown')}</strong></div>
      <div class="kpi"><span>Confidence</span><strong>${escapeHtml(data.confidence || 'Review')}</strong></div>
    </div>
    <div class="card">
      <h4>Funding & Token Sale Timeline</h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Valuation / Price</th><th>Investors / Platform</th><th>Source status</th></tr></thead>
          <tbody>
            ${rows.map(row => `<tr>
              <td>${escapeHtml(row.date || '—')}</td>
              <td>${escapeHtml(row.type || '—')}</td>
              <td>${escapeHtml(row.amount || '—')}</td>
              <td>${escapeHtml(row.valuation_or_price || '—')}</td>
              <td>${escapeHtml(row.investors_or_platform || '—')}</td>
              <td><span class="badge ${row.source_status?.toLowerCase().includes('found') ? 'good' : 'warn'}">${escapeHtml(row.source_status || 'Editor review')}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${actionButtons(JSON.stringify(rows, null, 2))}
    </div>
    <div class="grid-two">
      <div class="card"><h4>AI notes</h4><p>${escapeHtml(data.notes || '')}</p></div>
      <div class="card"><h4>Missing / future enrichment</h4><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>
    </div>
  `;
}

function renderLore(data) {
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  output.innerHTML = `
    <div class="quote-card">${escapeHtml(data.dramatic_title || `The ${state.wiki.title} Story`)}</div>
    <div class="grid-two">
      <div class="card"><h4>The short version</h4><p>${escapeHtml(data.short_version || '')}</p></div>
      <div class="card"><h4>Why it mattered</h4><p>${escapeHtml(data.why_it_mattered || '')}</p></div>
    </div>
    <div class="card">
      <h4>Lore timeline</h4>
      <div class="timeline">
        ${timeline.map(item => `
          <div class="timeline-item">
            <div class="timeline-date">${escapeHtml(item.date || '—')}</div>
            <div class="timeline-content">
              <strong>${escapeHtml(item.event || '')}</strong>
              <p>${escapeHtml(item.context || '')}</p>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div class="grid-two">
      <div class="card"><h4>Money involved</h4><ul>${(data.money_involved || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div class="card"><h4>Key people / projects</h4><ul>${(data.key_people_projects || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    </div>
    <div class="card"><h4>What changed / what went wrong / why it became important</h4><p>${escapeHtml(data.turning_point || '')}</p></div>
    <div class="grid-two">
      <div class="card"><h4>Receipts needed</h4><ul>${(data.receipts_needed || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div class="card"><h4>Related IQ.wiki pages</h4><ul>${(data.related_wikis || []).map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    </div>
    <div class="card"><h4>CTA</h4><p>${escapeHtml(data.cta || 'Read the full wiki on IQ.wiki.')}</p>${actionButtons(JSON.stringify(data, null, 2))}</div>
  `;
}

function actionButtons(text) {
  return `<div class="ai-actions">
    <button class="copy-btn" data-copy="${encodeURIComponent(text)}">Copy</button>
    <button class="copy-btn" data-open-modal="embed">Embed preview</button>
    <button class="copy-btn" data-open-modal="editor-review">Send to editor review</button>
  </div>`;
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.remove('hidden');
}
function hideStatus() { status.classList.add('hidden'); }
function setLoading(isLoading) {
  $('loadUrlBtn').disabled = isLoading;
  $('loadManualBtn').disabled = isLoading;
}

function openModal(kind) {
  const content = modalContent(kind);
  $('modalTitle').textContent = content.title;
  $('modalBody').innerHTML = content.body;
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }

function modalContent(kind) {
  const blocks = {
    architecture: {
      title: 'How this works',
      body: `<p>The serverless function calls free OpenRouter models without exposing the API key.</p>
        <ol>
          <li>Fetch wiki content server-side from the pasted IQ.wiki URL.</li>
          <li>Use OpenRouter Free to generate the scenario, script, and scene plan.</li>
          <li>Keep generative video as a separate provider, model, and API key.</li>
          <li>Render the selected ability as a standalone tab or embeddable widget.</li>
          <li>Mark missing facts as placeholders instead of inventing data.</li>
          <li>If free AI is unavailable, generate a deterministic local version. Never use a paid model.</li>
        </ol>`
    },
    embed: {
      title: 'Embed preview',
      body: `<p>In production, this ability could be rendered as an iframe, web component, or native IQ.wiki tab using the current wiki slug.</p><p><code>&lt;iq-ability-widget slug="nexus" ability="${state.activeTab}"&gt;&lt;/iq-ability-widget&gt;</code></p>`
    },
    'render-video': {
      title: 'Scenario preview',
      body: `<p>The browser canvas previews the OpenRouter-generated scene plan with optional narration. It is not generative video. A separate video provider will render the final clip once configured.</p>`
    },
    'editor-review': {
      title: 'Editor review',
      body: `<p>In production, this would save the generated module to an editorial queue. Editors would approve, edit, reject, or request source checks before publishing.</p>`
    },
    'production-short': {
      title: 'Short Video Studio',
      body: `<p>OpenRouter Free generates only the script and scene plan. A separate video provider and API key will render the generative video later. The disabled button marks that integration boundary.</p>`
    },
    'production-funding': {
      title: 'Funding Timeline production version',
      body: `<p>Current rule: use IQ.wiki text first. If missing, show placeholders. Later this can query DefiLlama, CryptoRank, RootData, or IQ.wiki internal fields, then require editor approval.</p>`
    },
    'production-lore': {
      title: 'Crypto Lore production version',
      body: `<p>Crypto Lore can become a hub format for collapses, launches, comeback stories, founders, and major events. The page links back to underlying wikis and sources.</p>`
    }
  };
  return blocks[kind] || blocks.architecture;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

init();
