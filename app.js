const API_BASE_STORAGE_KEY = 'iqAbilitiesApiBase';
const samples = [
  {
    title: 'Nexus',
    subtitle: 'zkVM / verifiable computation project',
    url: 'https://iq.wiki/wiki/nexus',
    sampleText: `Nexus is a Layer 1 blockchain and zero-knowledge virtual machine network designed for verifiable computation. It was founded by Daniel Marin in 2022. Nexus Labs launched its mainnet in May 2026. The project is positioned around verifiable finance, AI agents, and scalable proofs. Useful sections may include history, technology, team, token, mainnet launch, and sources.`
  },
  {
    title: 'Terra',
    subtitle: 'algorithmic stablecoin lore',
    url: 'https://iq.wiki/wiki/terra',
    sampleText: `Terra is a blockchain protocol and payment platform used for algorithmic stablecoins. The blockchain project was created in 2018 by Terraform Labs, a startup co-founded by Do Kwon and Daniel Shin. It is known for Terra stablecoins and the associated LUNA reserve asset. In May 2022, TerraUSD lost its peg and LUNA collapsed, creating one of the most significant failures in crypto history.`
  },
  {
    title: 'Do Kwon',
    subtitle: 'founder page with collapse/legal context',
    url: 'https://iq.wiki/wiki/do-kwon',
    sampleText: `Do Kwon is a South Korean entrepreneur and co-founder of Terraform Labs, known for TerraUSD and Luna. In May 2022, TerraUSD and Luna experienced a significant decline. In 2023, Do Kwon was arrested in Montenegro for allegedly using falsified documents. In 2024, Terraform Labs and Do Kwon reached a tentative settlement with the SEC related to the Terra collapse.`
  },
  {
    title: 'Daniel Marin',
    subtitle: 'founder profile',
    url: 'https://iq.wiki/wiki/daniel-marin',
    sampleText: `Daniel Marin is the founder and CEO of Nexus Labs, a Layer 1 blockchain and zero-knowledge virtual machine network. He studied computer science at Stanford and was an International Physics Olympiad medalist. Nexus was founded in 2022 and launched its mainnet in May 2026.`
  },
  {
    title: 'Solana',
    subtitle: 'high-throughput L1',
    url: 'https://iq.wiki/wiki/solana',
    sampleText: `Solana is a high-performance Layer 1 blockchain founded by Anatoly Yakovenko. It is known for high throughput and low transaction costs. Solana experienced network outages and major market pressure after the FTX collapse but later saw renewed ecosystem activity through DeFi, NFTs, DePIN, and memecoins.`
  },
  {
    title: 'Bittensor',
    subtitle: 'AI/crypto network',
    url: 'https://iq.wiki/wiki/bittensor',
    sampleText: `Bittensor is a decentralized machine learning network that uses blockchain incentives to coordinate AI model contributors. Its token TAO is used for rewards and participation in subnet markets. The project became one of the most visible AI and crypto networks during the rise of decentralized AI narratives.`
  }
];

const abilityCopy = {
  short: {
    label: 'Short Video Studio',
    title: 'Generate a TikTok/Reels-style short from this wiki',
    action: 'short_video'
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

  $('loadManualBtn').addEventListener('click', async () => {
    const text = $('manualText').value.trim();
    if (!text) return showStatus('Paste wiki text first.', true);
    await loadWiki({ manualText: text, url: $('wikiUrl').value.trim() || '' });
  });

  $('sampleGrid').addEventListener('click', async (event) => {
    const card = event.target.closest('[data-sample-index]');
    if (!card) return;
    const sample = samples[Number(card.dataset.sampleIndex)];
    $('wikiUrl').value = sample.url;
    await loadWiki({ url: sample.url, sampleText: sample.sampleText, sampleTitle: sample.title });
  });

  $('resetBtn').addEventListener('click', () => {
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
    let wiki;
    try {
      const response = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load_wiki', ...payload })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load wiki');
      wiki = data.wiki;
    } catch (error) {
      if (!payload.sampleText && !payload.manualText) throw error;
      wiki = buildLocalWiki(payload);
      wiki.loadMode = payload.manualText ? 'manual text' : 'sample fallback';
      wiki.loadNote = 'Server fetch failed, so the app used local sample/manual text.';
    }

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
    showStatus(`${error.message}. Use manual paste fallback or sample data.`, true);
  } finally {
    setLoading(false);
  }
}

function buildLocalWiki(payload) {
  const rawText = payload.manualText || payload.sampleText || '';
  const title = payload.sampleTitle || guessTitle(rawText) || 'Manual Wiki Text';
  return {
    title,
    url: payload.url || '',
    summary: rawText.slice(0, 280),
    rawText,
    sections: [{ heading: 'Article text', text: rawText }],
    dates: extractDates(rawText),
    moneyMentions: extractMoney(rawText),
    peopleMentions: [],
    projectMentions: [],
    sourceMentions: [],
    loadMode: payload.manualText ? 'manual text' : 'sample data'
  };
}

function renderWikiSummary() {
  const wiki = state.wiki;
  $('wikiTitle').textContent = wiki.title || 'Loaded wiki';
  $('wikiSource').textContent = wiki.url || 'Manual / sample content';
  $('wikiSource').href = wiki.url || '#';
  $('wikiSummaryText').textContent = wiki.summary || wiki.rawText?.slice(0, 260) || 'No summary extracted yet.';
  const badges = [
    wiki.loadMode || 'loaded content',
    'real AI generation',
    'editor review required',
    'widget-ready mockup'
  ];
  $('wikiBadges').innerHTML = badges.map((badge, idx) => `<span class="badge ${idx === 1 ? 'good' : idx === 2 ? 'warn' : ''}">${escapeHtml(badge)}</span>`).join('');
}

function setActiveTab(tabKey) {
  state.activeTab = tabKey;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabKey));
  $('activeAbilityLabel').textContent = abilityCopy[tabKey].label;
  $('activeAbilityTitle').textContent = abilityCopy[tabKey].title;
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
      body: JSON.stringify({ action: ability.action, wiki: state.wiki })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'AI generation failed');
    state.outputs[state.activeTab] = data.result;
    renderOutput();
    showStatus('Generated. Review before publishing or embedding.');
    setTimeout(() => hideStatus(), 1800);
  } catch (error) {
    output.innerHTML = `<div class="empty-state"><strong>Generation failed.</strong><br>${escapeHtml(error.message)}<br><br>Check that OPENROUTER_API_KEY is set in your serverless environment, or try again if the free model is rate-limited.</div>`;
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
    short: 'Generate AI hooks, script, captions, scene list, social captions, and a fake vertical preview.',
    funding: 'Generate a structured funding/token sale table using wiki content first. Missing data becomes placeholders.',
    lore: 'Generate a story-style crypto lore page from the loaded wiki.'
  };
  return `<div class="empty-state"><strong>${escapeHtml(abilityCopy[tab].label)}</strong><br>${escapeHtml(copy[tab])}<br><br><button class="secondary-btn" data-open-modal="production-${tab}">How this works in production</button></div>`;
}

function renderShort(data) {
  const hooks = Array.isArray(data.hooks) ? data.hooks : [];
  const scenes = Array.isArray(data.scenes) ? data.scenes : [];
  const hook = hooks[0] || `The story of ${state.wiki.title}`;
  const caption = scenes[0]?.caption || data.cta || 'Full wiki on IQ.wiki';
  output.innerHTML = `
    <div class="grid-two">
      <div class="card">
        <h4>Hook options</h4>
        <ol>${hooks.map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ol>
        ${actionButtons(hooks.join('\n'))}
      </div>
      <div class="phone-wrap">
        <div class="phone">
          <div class="phone-screen">
            <div class="phone-hook">${escapeHtml(hook)}</div>
            <div class="phone-caption">${escapeHtml(caption)}</div>
            <div class="phone-cta">Read full sources on IQ.wiki →</div>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <h4>30-second voiceover</h4>
      <p>${escapeHtml(data.voiceover || '').replace(/\n/g, '<br>')}</p>
      ${actionButtons(data.voiceover || '')}<button class="copy-btn" data-open-modal="render-video">Render video later</button>
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
      title: 'How this becomes real',
      body: `<p>This prototype uses a serverless function to call real AI without exposing the API key in the browser.</p>
        <ol>
          <li>Fetch wiki content server-side from the pasted IQ.wiki URL.</li>
          <li>Send the loaded article text to the AI with strict JSON prompts.</li>
          <li>Render the selected ability as a standalone tab or embeddable widget.</li>
          <li>Mark missing facts as placeholders instead of inventing data.</li>
          <li>Later: connect IQ.wiki API, Sophia, source-aware generation, and editor approval.</li>
        </ol>`
    },
    embed: {
      title: 'Embed preview',
      body: `<p>In production, this ability could be rendered as an iframe, web component, or native IQ.wiki tab using the current wiki slug.</p><p><code>&lt;iq-ability-widget slug="nexus" ability="${state.activeTab}"&gt;&lt;/iq-ability-widget&gt;</code></p>`
    },
    'render-video': {
      title: 'Render video later',
      body: `<p>This free prototype generates the video plan only. A production version could send the script, captions, and scene list into a template renderer, then save the MP4 back to the wiki page.</p><p>Current free mode: script + captions + fake phone preview.</p>`
    },
    'editor-review': {
      title: 'Editor review',
      body: `<p>In production, this would save the generated module to an editorial queue. Editors would approve, edit, reject, or request source checks before publishing.</p>`
    },
    'production-short': {
      title: 'Short Video Studio production version',
      body: `<p>Next step: connect a video rendering service or Remotion template. The AI already returns scenes, captions, visual suggestions, and a voiceover script.</p>`
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

function guessTitle(text) {
  const firstLine = text.split('\n').find(Boolean) || '';
  return firstLine.replace(/^#+\s*/, '').slice(0, 70);
}
function extractDates(text) {
  return [...new Set((text.match(/\b(?:19|20)\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+(?:19|20)\d{2}\b/gi) || []).slice(0, 10))];
}
function extractMoney(text) {
  return [...new Set((text.match(/\$\s?\d+(?:\.\d+)?\s?(?:k|m|b|million|billion)?|\d+(?:\.\d+)?\s?(?:million|billion)\s?(?:USD|dollars)?/gi) || []).slice(0, 10))];
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
