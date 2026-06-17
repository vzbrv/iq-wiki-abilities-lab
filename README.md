# IQ.wiki Abilities Lab

A lightweight, free-tier prototype that turns an IQ.wiki page into three AI-powered content modules:

1. **Short Video Studio** — hooks, 30-second voiceover, scene list, captions, TikTok/X captions, and a fake vertical preview.
2. **Funding & Token Sale Timeline** — extracts funding/token sale info only when it is present in the loaded wiki text; otherwise shows placeholders.
3. **Crypto Lore** — converts the wiki into a story-style lore page with timeline, why it mattered, money involved, key people/projects, and editor-review notes.

The app is standalone now, but designed so each tab can later become an embeddable IQ.wiki widget.

---

## Free stack

This prototype is designed to run on free tiers:

- Frontend: static HTML/CSS/JS
- Hosting + serverless API: Vercel free tier
- AI: OpenRouter free models
- Default model: `openrouter/free`
- Database: none
- Paid APIs: none
- Real video rendering: none

The OpenRouter API key is used only in the serverless function and is never exposed in browser code.

---

## What is actually AI-powered

The three generation tabs call `/api/generate`, which calls OpenRouter:

- `short_video`
- `funding_timeline`
- `crypto_lore`

The AI receives only the loaded wiki text. It is explicitly instructed not to invent facts, funding amounts, token prices, investors, legal claims, dates, or quotes.

---

## What works now

- Paste an IQ.wiki URL
- Server-side page fetch and text extraction
- Manual paste fallback
- Sample wiki fallback
- Real AI generation through OpenRouter
- Copy buttons
- Widget preview mode
- Production explanation modals
- Funding placeholder handling when data is missing

---

## Current limitations

- IQ.wiki page extraction is simple HTML parsing, not a proper IQ.wiki API integration.
- OpenRouter free models can be rate-limited or inconsistent.
- Funding data is extracted only if present in the loaded wiki text.
- No external funding databases are called.
- No real video file is rendered.
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

You can later change `OPENROUTER_MODEL` to another model without touching frontend code.

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
2. Add Sophia/OpenAI/internal model option.
3. Add citation-aware generation from wiki sources.
4. Add external funding enrichment only after wiki extraction fails.
5. Add editor approval workflow.
6. Turn each tab into an embeddable widget:
   - Short Video Studio widget
   - Funding Timeline widget
   - Crypto Lore widget
7. Add optional real video rendering:
   - AI script
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

For funding and token sale data, the prototype must not hallucinate. If the loaded wiki text does not contain a raise amount, token price, valuation, investor, or launchpad, the output should say:

```text
Not found in loaded wiki text
```

or show a placeholder marked:

```text
Source needed / Editor review required
```
