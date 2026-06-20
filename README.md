# IQ.wiki Video Studio

An embeddable widget for instant, prebuilt 15-second IQ.wiki explainers. When a stored video is unavailable, it converts the live article into a grounded production package:

- complete narration
- opening hooks
- topic-specific scene directions
- on-screen captions and source facts

The production profile is fixed to a cinematic explainer that is clear, easy to follow, and entertaining.

The script and scene plan use OpenRouter free models only. The server rejects any model without the `:free` suffix, except OpenRouter's `openrouter/free` router. It never falls back to a paid model.

Actual video rendering is deliberately separate and remains disabled until a video provider, model allowlist, credentials, and spending limits are explicitly configured.

Visitors never wait for rendering. The widget first checks the stored-video library and plays a current asset immediately.

## Material article changes

A stored video is invalidated when any of these are true:

- The title changes.
- A number, percentage, date, amount, or blockchain address changes.
- The article word count changes by 20% or more.
- Normalized article similarity falls below 90%.

Formatting, punctuation, and edits below those thresholds keep the existing video.

## Run

```bash
npm install
OPENROUTER_API_KEY=... npm run dev
```

Optional settings:

```bash
# Preferred models. Every entry must be openrouter/free or end in :free.
OPENROUTER_MODELS=openrouter/free,openai/gpt-oss-20b:free
ALLOWED_ORIGINS=https://your-site.example
LOAD_RATE_LIMIT=20
GENERATE_RATE_LIMIT=8
```

Configured models are tried first, followed by the built-in free-only fallback
list. `OPENROUTER_MODEL` remains supported when `OPENROUTER_MODELS` is unset.
The app validates every candidate and never attempts a paid model.

Use `?embed=1&url=<encoded-iq-wiki-url>` for a page-specific compact widget. Use an HTTPS `?api=https://api.example` only when the static frontend and API are hosted separately.

## Verify

```bash
npm test
npm run check
npm run deploy:check
```

## Video integration boundary

`GET /api/video?action=lookup&url=<iq.wiki-url>` is public. Publishing systems use authenticated `sync_article` and `publish_asset` actions to invalidate changed articles and attach completed assets to exact revisions.

Configure the durable Upstash-compatible REST store with:

```text
VIDEO_LIBRARY_REST_URL=https://...
VIDEO_LIBRARY_REST_TOKEN=...
VIDEO_LIBRARY_SYNC_TOKEN=...
```

The sync token belongs only in the IQ.wiki publishing worker, never in browser code.

`/api/video` also provides capability, generate, poll, retry, cancel, and playback job states. It is disabled by default and cannot select a provider or paid model automatically.

Local lifecycle testing:

```bash
VIDEO_ENGINE_ENABLED=true
VIDEO_PROVIDER=mock
VIDEO_PROVIDER_ALLOWLIST=mock
VIDEO_MODEL=mock-video-v1
VIDEO_MODEL_ALLOWLIST=mock-video-v1
VIDEO_MOCK_ENABLED=true
VIDEO_MAX_JOB_USD=0
VIDEO_DAILY_CAP_USD=0
```

The mock provider is rejected when `NODE_ENV=production`. Real providers also require a server-side `VIDEO_API_KEY`, explicit provider/model allowlists, and per-job/daily spending caps. A durable job store and spending ledger must replace the process-local test stores before a real provider is enabled.
