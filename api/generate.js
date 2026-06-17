const MAX_WIKI_CHARS = 28000;
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  try {
    const body = await readBody(req);
    const { action } = body || {};

    if (action === 'load_wiki') {
      const wiki = await loadWiki(body);
      return res.status(200).json({ wiki });
    }

    if (!['short_video', 'funding_timeline', 'crypto_lore'].includes(action)) {
      return res.status(400).json({ error: 'Invalid ability type.' });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: 'OPENROUTER_API_KEY is missing. Add it to your serverless environment variables.'
      });
    }

    if (!body.wiki || !body.wiki.rawText || body.wiki.rawText.length < 180) {
      return res.status(400).json({ error: 'Loaded wiki text is missing or too short.' });
    }

    const wiki = normalizeWiki(body.wiki);
    const prompt = buildPrompt(action, wiki);
    const result = await callOpenRouter(prompt, action, req.headers.host);
    return res.status(200).json({ result, model: DEFAULT_MODEL, provider: 'OpenRouter' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Unexpected server error.' });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  return JSON.parse(raw);
}

async function loadWiki({ url, manualText, sampleText, sampleTitle }) {
  if (manualText) {
    return normalizeWiki({
      title: sampleTitle || guessTitle(manualText) || 'Manual Wiki Text',
      url: url || '',
      rawText: manualText,
      loadMode: 'manual text'
    });
  }

  if (!url) throw new Error('Missing IQ.wiki URL.');
  assertIqWikiUrl(url);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'IQ.wiki Abilities Lab prototype/0.1',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) throw new Error(`IQ.wiki returned ${response.status}`);
    const html = await response.text();
    const extracted = extractTextFromHtml(html);
    const rawText = extracted.rawText || sampleText || '';
    if (!rawText || rawText.length < 140) throw new Error('Not enough article text extracted.');

    return normalizeWiki({
      title: extracted.title || sampleTitle || guessTitle(rawText) || 'Loaded IQ.wiki page',
      url,
      rawText,
      loadMode: 'real wiki loaded',
      loadNote: 'Fetched server-side from the pasted IQ.wiki URL.'
    });
  } catch (error) {
    if (sampleText) {
      return normalizeWiki({
        title: sampleTitle || guessTitle(sampleText) || 'Sample Wiki',
        url,
        rawText: sampleText,
        loadMode: 'sample fallback',
        loadNote: `Real fetch failed: ${error.message}`
      });
    }
    throw error;
  }
}

function assertIqWikiUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid URL.'); }
  const hostname = parsed.hostname.toLowerCase();
  const allowed = hostname === 'iq.wiki' || hostname.endsWith('.iq.wiki');
  if (!allowed) throw new Error('For this prototype, only iq.wiki URLs are allowed.');
}

function extractTextFromHtml(html) {
  const title = cleanText(
    getMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    getMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || ''
  ).replace(/\s*[-|]\s*IQ\.wiki.*$/i, '');

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  const main = getMatch(body, /<main[^>]*>([\s\S]*?)<\/main>/i) ||
               getMatch(body, /<article[^>]*>([\s\S]*?)<\/article>/i) ||
               body;

  const text = cleanText(main
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));

  const filtered = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 2)
    .filter(line => !/^(Home|Categories|Rank|Events|Glossary|More|Subscribe|Partner with IQ\.wiki|Toggle theme|Legal|Resources|Company)$/i.test(line))
    .join('\n')
    .slice(0, MAX_WIKI_CHARS);

  return { title, rawText: filtered };
}

function normalizeWiki(wiki) {
  const rawText = cleanText(wiki.rawText || '').slice(0, MAX_WIKI_CHARS);
  const title = wiki.title || guessTitle(rawText) || 'Loaded Wiki';
  const summary = summarizeLocally(rawText);
  return {
    title,
    url: wiki.url || '',
    summary,
    rawText,
    sections: splitSections(rawText),
    dates: extractDates(rawText),
    moneyMentions: extractMoney(rawText),
    peopleMentions: extractNamedPhrases(rawText).slice(0, 12),
    projectMentions: [],
    sourceMentions: extractSources(rawText),
    loadMode: wiki.loadMode || 'loaded content',
    loadNote: wiki.loadNote || ''
  };
}

function buildPrompt(action, wiki) {
  const shared = `
You are generating IQ.wiki content modules for a lightweight product prototype.

CRITICAL RULES:
- Use ONLY the loaded IQ.wiki text provided below.
- Do NOT invent facts, funding numbers, investors, token prices, dates, legal claims, or quotes.
- If a detail is missing, write "Not found in loaded wiki text" or create a clearly marked placeholder.
- Keep outputs punchy and crypto-native, not generic encyclopedia copy.
- Every output is an AI draft requiring editor review.
- Return STRICT JSON only. No markdown fences. No commentary outside JSON.

Loaded wiki title: ${wiki.title}
Loaded wiki URL: ${wiki.url || 'manual/sample'}
Detected dates: ${wiki.dates.join(', ') || 'none'}
Detected money mentions: ${wiki.moneyMentions.join(', ') || 'none'}
Summary: ${wiki.summary}

Loaded wiki text:
${wiki.rawText.slice(0, MAX_WIKI_CHARS)}
`;

  if (action === 'short_video') {
    return `${shared}
Create a Short Video Studio output for TikTok/Reels/Shorts.
Return JSON with this exact shape:
{
  "hooks": ["5 hook options under 13 words each"],
  "voiceover": "A 25-35 second voiceover script. Factual, fast, slightly dramatic.",
  "scenes": [
    {"time":"0-3s", "visual":"visual direction", "caption":"on-screen caption", "voiceover":"line for this scene"}
  ],
  "suggested_visuals": ["logos, wiki screenshots, charts, timelines, source screenshots, but no fabricated imagery"],
  "tiktok_caption": "caption with CTA",
  "x_caption": "caption with CTA",
  "cta": "short CTA back to IQ.wiki",
  "fact_check": ["specific facts from the script that need editor/source verification"]
}`;
  }

  if (action === 'funding_timeline') {
    return `${shared}
Create a Funding & Token Sale Timeline from the loaded wiki text.
Return JSON with this exact shape:
{
  "total_raised_found": "amount if explicitly present, otherwise Not found",
  "token_sale_status": "found / not found / partial",
  "confidence": "High / Medium / Low - reason",
  "rows": [
    {
      "date":"date or Not found",
      "type":"Seed / Series A / Strategic / ICO / IDO / IEO / Token sale / Airdrop / Other / Placeholder",
      "amount":"amount or Not found",
      "valuation_or_price":"valuation or token price or Not found",
      "investors_or_platform":"investors/platform or Not found",
      "source_status":"Found in loaded wiki text / Not found in loaded wiki text / Placeholder for future enrichment"
    }
  ],
  "notes":"brief explanation of what was and was not found",
  "warnings":["missing data and future enrichment suggestions"]
}
If no real funding/token-sale data is present, include one placeholder row only and warnings. Do not invent data.`;
  }

  if (action === 'crypto_lore') {
    return `${shared}
Create a Crypto Lore page draft from the loaded wiki text.
Return JSON with this exact shape:
{
  "dramatic_title":"story-style title, factual not clickbait",
  "short_version":"2-4 sentence summary",
  "why_it_mattered":"why crypto people should care, based only on loaded text",
  "timeline":[
    {"date":"date or era", "event":"event", "context":"why it matters"}
  ],
  "money_involved":["money/funding/market impact facts if present, otherwise missing-data notes"],
  "key_people_projects":["people/projects mentioned in loaded text"],
  "turning_point":"what changed, went wrong, or made this important; if not a collapse/scandal, describe the main narrative shift",
  "receipts_needed":["facts that need original source verification before publishing"],
  "related_wikis":["likely related IQ.wiki page names mentioned in text"],
  "cta":"CTA back to full IQ.wiki page"
}`;
  }

  throw new Error(`Unknown action: ${action}`);
}

async function callOpenRouter(prompt, action, host = '') {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': host ? `https://${host}` : 'https://iq.wiki',
      'X-Title': 'IQ.wiki Abilities Lab'
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'Return valid JSON only. Follow the user instructions exactly.' },
        { role: 'user', content: prompt }
      ],
      temperature: action === 'funding_timeline' ? 0.15 : 0.45,
      max_tokens: action === 'crypto_lore' ? 2600 : 2200
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenRouter returned ${response.status}`;
    throw new Error(message);
  }

  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenRouter returned an empty response. Try again.');
  return parseJsonStrict(text);
}

function parseJsonStrict(text) {
  const cleaned = String(text || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('AI did not return valid JSON. Try again or use another free OpenRouter model.');
  }
}

function splitSections(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const chunks = [];
  let current = { heading: 'Overview', text: '' };

  for (const line of lines) {
    const isHeading = line.length < 80 && /^[A-Z0-9][A-Za-z0-9\s&/()\-:]+$/.test(line) && !line.endsWith('.');
    if (isHeading && current.text.length > 180) {
      chunks.push(current);
      current = { heading: line, text: '' };
    } else {
      current.text += `${line}\n`;
    }
  }
  if (current.text.trim()) chunks.push(current);
  return chunks.slice(0, 12);
}

function summarizeLocally(text) {
  const cleaned = cleanText(text);
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [];
  return (sentences.slice(0, 3).join(' ') || cleaned.slice(0, 320)).trim();
}

function cleanText(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : '';
}

function guessTitle(text) {
  const line = cleanText(text).split('\n').find(Boolean) || '';
  return line.replace(/^#+\s*/, '').slice(0, 80);
}

function extractDates(text) {
  const matches = text.match(/\b(?:19|20)\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+(?:19|20)\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:19|20)\d{2}\b/gi) || [];
  return [...new Set(matches)].slice(0, 20);
}

function extractMoney(text) {
  const matches = text.match(/\$\s?\d+(?:\.\d+)?\s?(?:k|m|b|mn|bn|million|billion)?|\d+(?:\.\d+)?\s?(?:million|billion)\s?(?:USD|dollars)?/gi) || [];
  return [...new Set(matches)].slice(0, 20);
}

function extractNamedPhrases(text) {
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g) || [];
  return [...new Set(matches)].filter(name => !/IQ Wiki|United States|New York|Hong Kong/.test(name));
}

function extractSources(text) {
  const matches = text.match(/\[(?:\d+|source needed|citation needed)\]|https?:\/\/\S+/gi) || [];
  return [...new Set(matches)].slice(0, 30);
}
