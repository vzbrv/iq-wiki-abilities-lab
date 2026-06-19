# IQ.wiki Video Studio

Visitor-ready studio that converts a live IQ.wiki article into a grounded 15–30 second production package:

- complete narration
- opening hooks
- topic-specific scene directions
- on-screen captions and source facts

The script and scene plan use OpenRouter free models only. The server rejects any model without the `:free` suffix, except OpenRouter's `openrouter/free` router. It never falls back to a paid model.

Actual video rendering is deliberately separate and remains disabled until a video provider, model allowlist, credentials, and spending limits are explicitly configured.

## Run

```bash
npm install
OPENROUTER_API_KEY=... npm run dev
```

Optional settings:

```bash
OPENROUTER_MODEL=openrouter/free
ALLOWED_ORIGINS=https://your-site.example
LOAD_RATE_LIMIT=20
GENERATE_RATE_LIMIT=8
```

Use `?embed=1` for the compact embedded layout. Use `?api=https://api.example` only when the static frontend and API are hosted separately.

## Verify

```bash
npm test
npm run check
npm run deploy:check
```

## Video integration boundary

`/api/video` provides capability, generate, poll, retry, cancel, and playback job states. It is disabled by default and cannot select a provider or paid model automatically.

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
