# IQ.wiki Abilities Lab

A free, deployable app that turns an IQ.wiki page into three AI-powered content modules:

1. **Short Video Studio** — generates a source-backed 15–30 second scenario, script, and scene plan, with an in-browser preview.
2. **Funding & Token Sale Timeline** — extracts funding/token sale info only when it is present in the loaded wiki text; otherwise shows placeholders.
3. **Crypto Lore** — converts the wiki into a story-style lore page with timeline, why it mattered, money involved, key people/projects, and editor-review notes.

The app works standalone and each result can be embedded as an IQ.wiki widget.

---

## Current stack

The working app is designed to run on free tiers:

- Frontend: static HTML/CSS/JS
- Hosting + serverless API: Vercel free tier
- Scenario/content AI: OpenRouter free models
- Default model: `openrouter/free`
- Generative video: separate provider slot, currently unconfigured and disabled
- Database: none
- Paid APIs: none
- Scenario preview: browser canvas and built-in speech synthesis
- Paid model fallback: disabled

The OpenRouter API key is used only for scenario/content generation in the serverless function and is never exposed in browser code. It is not a video-generation key.

## Provider boundary

- `video_scenario` calls OpenRouter using a free-only model and returns planning JSON.
- OpenRouter never renders video in this app.
- Generative video requires a separate provider, model, API key, and API call.
- No video provider or video API key is configured yet, so **Generate AI video** is disabled.
- The server accepts legacy `short_video` requests for compatibility and treats them as `video_scenario`.
- `OPENROUTER_API_KEY` must never be forwarded to a future video provider.

---

## What is actually AI-powered

The three generation tabs call `/api/generate`, which calls OpenRouter:

- `video_scenario`
- `funding_timeline`
- `crypto_lore`

The AI receives only the loaded wiki text. It is explicitly instructed not to invent facts, funding amounts, token prices, investors, legal claims, dates, or quotes.

---

## What works now

- Paste an IQ.wiki URL
- Server-side page fetch and text extraction
- Manual paste fallback
- Sample wiki fallback
- Free-only AI generation through OpenRouter
- Deterministic local fallback when free models are unavailable or rate-limited
- Source-backed video scenario generation
- Embedded scenario preview with narration
- Disabled generative-video handoff ready for a separate provider
- Copy buttons
- Widget preview mode
- Production explanation modals
- Funding placeholder handling when data is missing

---

## Current limitations

- IQ.wiki page extraction is simple HTML parsing, not a proper IQ.wiki API integration.
- OpenRouter free models can be rate-limited or inconsistent; local generation keeps the app working.
- Funding data is extracted only if present in the loaded wiki text.
- No external funding databases are called.
- The canvas is a scenario preview, not generative video.
- No generative video model is connected, and no MP4 is rendered.
- All generated outputs are drafts and require editor review.

---

## Run locally

Install Vercel CLI if needed:

```bash
npm i -g vercel
```

From this folder:

```bash
vercel dev
```

Then open:

```bash
http://localhost:3000
```

---

## Required environment variables

Add this in Vercel project settings or in local `.env`:

```bash
OPENROUTER_API_KEY=your_openrouter_key
```

Optional:

```bash
OPENROUTER_MODEL=openrouter/free
```

`OPENROUTER_MODEL` must be `openrouter/free` or end in `:free`. Paid model IDs are rejected and use the local fallback.

There is intentionally no video-provider environment variable yet. Add one only when a separate video model is selected.

---

## Deploy on Vercel for free

1. Push this folder to a GitHub repo.
2. Import the repo into Vercel.
3. Add environment variable:
   - `OPENROUTER_API_KEY`
4. Deploy.
5. Paste an IQ.wiki URL and generate tabs.

---

## GitHub Pages note

GitHub Pages alone cannot run `/api/generate`, so real AI will not work on GitHub Pages by itself.

If the frontend is hosted on GitHub Pages, deploy the API separately on Vercel and paste that Vercel URL into the app's “API endpoint base URL” field.

Example:

```text
https://your-iq-abilities-api.vercel.app
```

The frontend will then call:

```text
https://your-iq-abilities-api.vercel.app/api/generate
```

---

## Production path

To turn this into a real IQ.wiki feature:

1. Replace HTML scraping with IQ.wiki API content fetch.
2. Choose and connect a separate generative-video provider and API key.
3. Add citation-aware generation from wiki sources.
4. Add external funding enrichment only after wiki extraction fails.
5. Add editor approval workflow.
6. Turn each tab into an embeddable widget:
   - Short Video Studio widget
   - Funding Timeline widget
   - Crypto Lore widget
7. Add generative video rendering:
   - OpenRouter Free scenario JSON as input
   - Separate video provider and model
   - AI voice
   - Remotion/template renderer
   - MP4 stored and embedded on wiki pages

---

## File structure

```text
index.html
styles.css
app.js
api/generate.js
package.json
vercel.json
README.md
```

---

## Safety / accuracy rule

For funding and token sale data, the app must not hallucinate. If the loaded wiki text does not contain a raise amount, token price, valuation, investor, or launchpad, the output should say:

```text
Not found in loaded wiki text
```

or show a placeholder marked:

```text
Source needed / Editor review required
```
